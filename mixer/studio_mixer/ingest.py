"""One decode pipeline per source.

Every source, whatever reached MediaMTX (WHIP from OBS, Larix or the studio
page, SRT, RTMP), is read back from MediaMTX over local RTSP, decoded,
scaled to the programme format and handed to the mixing pipeline through
inter* elements. Each source runs in its own pipeline, so a source that
drops, stalls or errors restarts on its own while Programme keeps running.

The picture is stretched to the programme size here; the scene layers undo
that with their crop and pad sizes, using the source's real size recorded
in `info` (see scene.py).
"""

from __future__ import annotations

import logging
import time
from typing import Callable

from gi.repository import GLib, Gst

from .media import AUDIO_CAPS, Format, audio_channel, video_channel

log = logging.getLogger(__name__)

STALL_SECONDS = 3.0
MAX_BACKOFF_SECONDS = 4.0


class SourceIngest:
    def __init__(self, source_id: str, url: str, fmt: Format, on_change: Callable[[], None]) -> None:
        self.source_id = source_id
        self.url = url
        self.fmt = fmt
        self.on_change = on_change
        self.pipeline: Gst.Pipeline | None = None
        self.state = "waiting"  # waiting -> connected -> (no_signal -> connected)
        self.info: dict = {}
        self.last_buffer = 0.0
        self.connected_since: float | None = None
        self.restarts = 0
        self._backoff = 1.0
        self._restart_source: int | None = None
        self._watchdog: int | None = None
        self._stopped = False

    def start(self) -> None:
        self._stopped = False
        self._build()
        self._watchdog = GLib.timeout_add(1000, self._check_stall)

    def stop(self) -> None:
        self._stopped = True
        for attr in ("_watchdog", "_restart_source"):
            src = getattr(self, attr)
            if src:
                GLib.source_remove(src)
                setattr(self, attr, None)
        self._teardown()

    def kick(self) -> None:
        """A publisher just appeared in MediaMTX: connect now instead of waiting for the backoff."""
        if self._stopped or self.state == "connected":
            return
        if self._restart_source:
            GLib.source_remove(self._restart_source)
            self._restart_source = None
        self._teardown()
        self._backoff = 1.0
        self._build()

    def snapshot(self) -> dict:
        return {"state": self.state, "restarts": self.restarts, "connected_since": self.connected_since, **self.info}

    # ---------------------------------------------------------------- build

    def _build(self) -> None:
        desc = (
            f'rtspsrc name=src location="{self.url}" protocols=tcp latency=80 do-retransmission=false '
            "timeout=3000000 tcp-timeout=3000000 ! "
            "decodebin name=dec "
            f"intervideosink name=vsink channel={video_channel(self.source_id)} sync=false async=false "
            f"interaudiosink name=asink channel={audio_channel(self.source_id)} sync=false async=false"
        )
        pipeline = Gst.parse_launch(desc)
        pipeline.set_name(f"ingest-{self.source_id}")
        src = pipeline.get_by_name("src")
        src.connect("pad-added", self._on_src_pad)
        pipeline.get_by_name("dec").connect("pad-added", self._on_pad_added)
        bus = pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_message)
        self.pipeline = pipeline
        self.last_buffer = 0.0
        pipeline.set_state(Gst.State.PLAYING)

    def _on_src_pad(self, src, pad: Gst.Pad) -> None:
        # rtspsrc exposes one pad per track; the first goes into decodebin by the launch line,
        # later ones (usually audio) get their own decodebin.
        if pad.is_linked() or self.pipeline is None:
            return
        dec = Gst.ElementFactory.make("decodebin")
        dec.connect("pad-added", self._on_pad_added)
        self.pipeline.add(dec)
        dec.sync_state_with_parent()
        pad.link(dec.get_static_pad("sink"))

    def _teardown(self) -> None:
        if self.pipeline is None:
            return
        self.pipeline.get_bus().remove_signal_watch()
        self.pipeline.set_state(Gst.State.NULL)
        self.pipeline = None

    def _on_pad_added(self, _dec, pad: Gst.Pad) -> None:
        caps = pad.get_current_caps() or pad.query_caps(None)
        name = caps.get_structure(0).get_name()
        pipeline = self.pipeline
        if pipeline is None:
            return
        if name.startswith("video/"):
            chain = (
                "queue max-size-buffers=3 leaky=downstream ! videoconvertscale add-borders=false ! "
                f'videorate drop-only=false ! capsfilter caps="{self.fmt.caps()}"'
            )
            sink = pipeline.get_by_name("vsink")
            self._record_video_caps(caps)
        elif name.startswith("audio/"):
            chain = ("queue max-size-time=500000000 leaky=downstream ! audioconvert ! audioresample ! "
                     f'capsfilter caps="{AUDIO_CAPS}"')
            sink = pipeline.get_by_name("asink")
            self.info["audio"] = True
        else:
            return
        if sink.get_static_pad("sink").is_linked():
            return  # a second video or audio track: ignore it
        bin_ = Gst.parse_bin_from_description(chain, True)
        pipeline.add(bin_)
        bin_.link(sink)
        bin_.sync_state_with_parent()
        pad.link(bin_.get_static_pad("sink"))
        if name.startswith("video/"):
            pad.add_probe(Gst.PadProbeType.BUFFER, self._on_video_buffer)
            # Phones rotate and encoders change size mid-stream: keep the real size current.
            pad.add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM, self._on_video_event)

    def _on_video_event(self, _pad, info):
        ev = info.get_event()
        if ev and ev.type == Gst.EventType.CAPS:
            before = (self.info.get("width"), self.info.get("height"))
            self._record_video_caps(ev.parse_caps())
            if before != (self.info.get("width"), self.info.get("height")) and before != (None, None):
                GLib.idle_add(lambda: (self.on_change(), False)[1])
        return Gst.PadProbeReturn.OK

    def _record_video_caps(self, caps: Gst.Caps) -> None:
        s = caps.get_structure(0)
        ok_w, width = s.get_int("width")
        ok_h, height = s.get_int("height")
        ok_f, num, den = s.get_fraction("framerate")
        if ok_w and ok_h:
            self.info.update(width=width, height=height)
        if ok_f and den:
            self.info["fps"] = round(num / den, 2)

    def _on_video_buffer(self, _pad, _info):
        self.last_buffer = time.monotonic()
        if self.state != "connected":
            GLib.idle_add(self._mark_connected)
        return Gst.PadProbeReturn.OK

    def _mark_connected(self) -> bool:
        if self.state != "connected" and not self._stopped:
            self.state = "connected"
            self.connected_since = time.time()
            self._backoff = 1.0
            self.info.pop("last_error", None)
            log.info("source %s connected %s", self.source_id, self.info)
            self.on_change()
        return False

    def _on_message(self, _bus, msg: Gst.Message) -> None:
        if msg.type == Gst.MessageType.ERROR:
            err, _dbg = msg.parse_error()
            log.debug("source %s error: %s", self.source_id, err.message)
            if self.state == "connected":
                self.info["last_error"] = err.message
            self._schedule_restart()
        elif msg.type == Gst.MessageType.EOS:
            self._schedule_restart()

    def _check_stall(self) -> bool:
        if self._stopped:
            return False
        if self.state == "connected" and time.monotonic() - self.last_buffer > STALL_SECONDS:
            log.info("source %s stalled", self.source_id)
            self._schedule_restart()
        return True

    def _schedule_restart(self) -> None:
        if self._stopped or self._restart_source:
            return
        was_connected = self.state == "connected"
        if was_connected:
            self.state = "no_signal"
        self.connected_since = None
        GLib.idle_add(self._teardown_idle)
        if was_connected:
            self.on_change()
        delay = self._backoff
        self._backoff = min(self._backoff * 2, MAX_BACKOFF_SECONDS)
        self._restart_source = GLib.timeout_add(int(delay * 1000), self._restart)

    def _teardown_idle(self) -> bool:
        if self._restart_source:  # still waiting to restart: drop the failed pipeline
            self._teardown()
        return False

    def _restart(self) -> bool:
        self._restart_source = None
        if not self._stopped:
            self.restarts += 1
            self._teardown()
            self._build()
        return False
