"""Pushes an MPEG-TS byte stream from the mixing pipeline to MediaMTX over SRT.

The Program pipeline ends in an appsink; this class owns a separate tiny
pipeline (appsrc ! srtsink) and copies buffers across. If MediaMTX goes away
the publish pipeline errors and is rebuilt, while the mixing pipeline never
sees the failure: buffers are simply dropped until the link is back.
"""

from __future__ import annotations

import logging

from gi.repository import GLib, Gst

from .media import TS_CAPS

log = logging.getLogger(__name__)


class SrtPublisher:
    def __init__(self, name: str, srt_uri: str, streamid: str) -> None:
        self.name = name
        self.srt_uri = srt_uri
        self.streamid = streamid
        self.pipeline: Gst.Pipeline | None = None
        self.appsrc = None
        self.connected = False
        self._restart_source: int | None = None
        self._stopped = False

    def attach(self, appsink: Gst.Element) -> None:
        appsink.set_property("emit-signals", True)
        appsink.set_property("sync", False)
        appsink.set_property("max-buffers", 200)
        appsink.set_property("drop", True)
        appsink.connect("new-sample", self._on_sample)

    def start(self) -> None:
        self._stopped = False
        self._build()

    def stop(self) -> None:
        self._stopped = True
        if self._restart_source:
            GLib.source_remove(self._restart_source)
            self._restart_source = None
        self._teardown()

    def _build(self) -> None:
        desc = (
            f'appsrc name=src is-live=true do-timestamp=true block=false format=time '
            f'max-bytes=4000000 leaky-type=downstream caps="{TS_CAPS}" ! '
            f"srtsink name=sink uri={self.srt_uri} wait-for-connection=false sync=false"
        )
        pipeline = Gst.parse_launch(desc)
        pipeline.set_name(f"publish-{self.name}")
        pipeline.get_by_name("sink").set_property("streamid", self.streamid)
        bus = pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_message)
        self.appsrc = pipeline.get_by_name("src")
        self.pipeline = pipeline
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            self._schedule_restart()
            return
        self.connected = True

    def _teardown(self) -> None:
        self.appsrc = None
        self.connected = False
        if self.pipeline is not None:
            self.pipeline.get_bus().remove_signal_watch()
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None

    def _on_sample(self, sink) -> Gst.FlowReturn:
        sample = sink.emit("pull-sample")
        appsrc = self.appsrc
        if sample is not None and appsrc is not None:
            appsrc.emit("push-buffer", sample.get_buffer())
        return Gst.FlowReturn.OK

    def _on_message(self, _bus, msg: Gst.Message) -> None:
        if msg.type in (Gst.MessageType.ERROR, Gst.MessageType.EOS):
            if msg.type == Gst.MessageType.ERROR:
                log.warning("publisher %s error: %s", self.name, msg.parse_error()[0].message)
            self._schedule_restart()

    def _schedule_restart(self) -> None:
        if self._stopped or self._restart_source:
            return
        self._teardown()
        self._restart_source = GLib.timeout_add(1000, self._restart)

    def _restart(self) -> bool:
        self._restart_source = None
        if not self._stopped:
            self._build()
        return False
