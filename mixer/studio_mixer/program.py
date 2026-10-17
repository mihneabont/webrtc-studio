"""The mixing pipeline: Programme, Preview, the control multiview, audio, keys and switching.

    scene bins ──► pgm compositor (programme size) ──► tee ─► encoder ─┐
    overlay keys ─┘   + fade-to-black pad                 └► 640x360 ─► mv ┐
    scene bins ──► pvw compositor (640x360) ───────────────────────────► mv │
    source tiles (intervideosrc) ──────────────────────────────────────► mv ┴► encoder ─┐
    per-source audio ─► volume ─► level ─► audiomixer ─► master ─► FTB ─┬► AAC ─► programme TS
                                                                         └► Opus ─► programme TS, multiview TS

The programme TS goes to MediaMTX path "program" (outputs and receivers read
it); the multiview TS to "multiview", which the control page plays over WebRTC.
Switching never touches the encoders: a take only changes pad properties on
the main compositor (see scene.py for why a scene is one pad).
"""

from __future__ import annotations

import logging
import time
from typing import Callable

from gi.repository import GLib, Gst

from .ingest import SourceIngest
from .media import (AUDIO_CAPS, MV_BIG, MV_FPS, MV_HEIGHT, MV_TILES, MV_WIDTH, Encoder, Format,
                    audio_channel, mv_tile_rect, video_channel)
from .publisher import SrtPublisher
from .scene import SceneBin, make

log = logging.getLogger(__name__)

TICK_MS = 16
Z_SCENE, Z_ENTER, Z_KEYS, Z_FTB = 10, 20, 100, 1000


def ease(p: float) -> float:
    return 2 * p * p if p < 0.5 else 1 - ((-2 * p + 2) ** 2) / 2


def db_to_gain(db: float) -> float:
    return 0.0 if db <= -60 else 10 ** (db / 20)


def level_db(v: float) -> float:
    return -90.0 if v != v or v < -90 else round(v, 1)


def default_kbps(height: int) -> int:
    return 6000 if height >= 1000 else 4000 if height >= 700 else 2000


class Program:
    def __init__(self, fmt: Format, encoder: Encoder, srt_uri: str, streamid: Callable[[str], str],
                 source_url: Callable[[str], str], gfx: Callable[[str], bytes | None],
                 on_status: Callable[[dict], None], on_meters: Callable[[dict], None],
                 kbps: int | None = None) -> None:
        self.fmt = fmt
        self.encoder = encoder
        self.srt_uri = srt_uri
        self.streamid = streamid
        self.source_url = source_url
        self.gfx = gfx
        self.on_status = on_status
        self.on_meters = on_meters
        self.kbps = kbps or default_kbps(fmt.height)

        self.pipeline: Gst.Pipeline | None = None
        self.publishers: list[SrtPublisher] = []
        self.sources: dict[str, dict] = {}  # id -> {name, ingest, tile, audio elements}
        self.order: list[str] = []
        self.scenes: dict[str, dict] = {}
        self.overlays: dict[str, dict] = {}
        self.audio = {"channels": {}, "masterDb": 0.0, "ftbAudio": True}
        self.transition = {"type": "mix", "duration": 1000}
        self.swap_on_take = True

        self.preview: str | None = None
        self.programme: str | None = None
        self.pgm_bin: SceneBin | None = None
        self.pvw_bin: SceneBin | None = None
        self.pending: SceneBin | None = None  # cut waiting for its first frame
        self.trans: dict | None = None
        self.ftb = {"black": False, "v": 0.0, "from": 0.0, "to": 0.0, "start": 0.0, "dur": 1.0}
        self._tick: int | None = None
        self._dirty = False
        self._timers: list[int] = []
        self.meters: dict = {"sources": {}, "master": None}
        self.started_at = time.time()
        self.fps_count = 0
        self.fps = 0.0
        # Encoded frames per encoder this second, and for how many seconds frames went in but none came out.
        self.enc_count = {"pparse": 0, "mvparse": 0}
        self.enc_stalled = 0

    # =============================================================== build

    def start(self) -> None:
        f = self.fmt
        gop = f.fps * 2
        enc = self.encoder.describe(self.kbps, gop)
        mv_enc = self.encoder.describe(2500, MV_FPS * 2, profile=self.encoder.preview_profile)
        leaky = "queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream"
        desc = (
            f"compositor name=pgm background=black force-live=true latency={Gst.SECOND // f.fps} ! "
            f"video/x-raw,width={f.width},height={f.height},framerate={f.fps}/1 ! videoconvert ! "
            "video/x-raw,format=I420 ! identity name=pgmrate ! tee name=pt allow-not-linked=true "
            f"pt. ! {leaky} ! {enc} ! h264parse name=pparse config-interval=-1 ! queue ! pmux. "
            f"pt. ! {leaky} ! videoscale ! video/x-raw,width={MV_BIG[0]},height={MV_BIG[1]} ! mv.sink_0 "
            f"compositor name=pvw background=black force-live=true ! "
            f"video/x-raw,width={MV_BIG[0]},height={MV_BIG[1]},framerate={MV_FPS}/1 ! {leaky} ! mv.sink_1 "
            f"compositor name=mv background=black force-live=true ! "
            f"video/x-raw,width={MV_WIDTH},height={MV_HEIGHT},framerate={MV_FPS}/1 ! {leaky} ! {mv_enc} ! "
            "h264parse name=mvparse config-interval=-1 ! queue ! mvmux. "
            # Fade to black sits on top of everything on Programme.
            f"videotestsrc is-live=true pattern=black ! video/x-raw,format=AYUV,width=16,height=16,framerate={f.fps}/1 ! pgm.sink_0 "
            f"videotestsrc is-live=true pattern=black ! video/x-raw,format=AYUV,width=16,height=16,framerate={MV_FPS}/1 ! pvw.sink_0 "
            # Audio: a silent bed keeps the mixer running with no sources.
            f"audiotestsrc is-live=true wave=silence ! {AUDIO_CAPS} ! amix.sink_0 "
            f"audiomixer name=amix force-live=true latency={200 * Gst.MSECOND} ! {AUDIO_CAPS} ! "
            "volume name=master ! volume name=ftbvol ! level name=lvlm interval=100000000 post-messages=true ! tee name=at "
            "at. ! queue ! audioconvert ! avenc_aac bitrate=160000 ! aacparse ! queue ! pmux. "
            "at. ! queue ! audioconvert ! audioresample ! opusenc bitrate=96000 ! tee name=ot "
            "ot. ! queue ! pmux. ot. ! queue ! mvmux. "
            "mpegtsmux name=pmux alignment=7 latency=100000000 ! appsink name=pgm_out "
            "mpegtsmux name=mvmux alignment=7 latency=100000000 ! appsink name=mv_out"
        )
        self.pipeline = Gst.parse_launch(desc)
        self.pipeline.set_name("mixer")
        self.pgm = self.pipeline.get_by_name("pgm")
        self.pvw = self.pipeline.get_by_name("pvw")
        self.mv = self.pipeline.get_by_name("mv")
        self.amix = self.pipeline.get_by_name("amix")
        ftb = self.pgm.get_static_pad("sink_0")
        for k, v in (("width", f.width), ("height", f.height), ("zorder", Z_FTB), ("alpha", 0.0)):
            ftb.set_property(k, v)
        base = self.pvw.get_static_pad("sink_0")
        base.set_property("width", MV_BIG[0])
        base.set_property("height", MV_BIG[1])
        self.mv.get_static_pad("sink_0").set_property("xpos", MV_BIG[0])
        self.pipeline.get_by_name("pgmrate").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, self._count_frame)
        for name in ("pparse", "mvparse"):
            self.pipeline.get_by_name(name).get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, self._count_encoded, name)

        for sink_name, path, parse in (("pgm_out", "program", "pparse"), ("mv_out", "multiview", "mvparse")):
            pub = SrtPublisher(path, self.srt_uri, self.streamid(path))
            pub.attach(self.pipeline.get_by_name(sink_name))
            self.publishers.append(pub)
            self._start_on_video(pub, self.pipeline.get_by_name(parse))
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_message)
        self.pipeline.set_state(Gst.State.PLAYING)
        self._apply_master()
        self._timers.append(GLib.timeout_add(250, self._status_tick))
        self._timers.append(GLib.timeout_add(1000, self._fps_tick))
        log.info("mixer running at %dx%d %dfps, %d kbps with %s", f.width, f.height, f.fps, self.kbps, self.encoder.name)

    def _start_on_video(self, pub: SrtPublisher, parse: Gst.Element) -> None:
        """Start publishing only once the first encoded video frame exists.

        Audio is ready at once but the H.264 encoder takes a moment (longer with no
        sources). Until it has output, the video stream has no caps, so the first
        MPEG-TS tables list audio only, and MediaMTX keeps the path audio-only for
        good: a black preview, and outputs failing with "Stream map matches no
        streams". Waiting for the first video buffer avoids that."""
        state = {"done": False, "timer": None}

        def go(why: str) -> bool:
            if state["timer"] in self._timers:  # it fires once; stop() must not remove it again
                self._timers.remove(state["timer"])
                if not why:
                    GLib.source_remove(state["timer"])
            if not state["done"] and pub in self.publishers:
                state["done"] = True
                if why:
                    log.warning("publishing %s %s", pub.name, why)
                pub.start()
            return False

        def first_video(_pad, _info):
            GLib.idle_add(go, "")
            return Gst.PadProbeReturn.REMOVE

        parse.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, first_video)
        state["timer"] = GLib.timeout_add(10000, go, "without video: the encoder produced nothing for 10 s")
        self._timers.append(state["timer"])

    def stop(self) -> None:
        for t in self._timers:
            GLib.source_remove(t)
        self._timers.clear()
        if self._tick:
            GLib.source_remove(self._tick)
            self._tick = None
        for s in list(self.sources):
            self._remove_source(s)
        for pub in self.publishers:
            pub.stop()
        self.publishers.clear()  # a late first-video callback must not start them again
        if self.pipeline is not None:
            self.pipeline.get_bus().remove_signal_watch()
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None

    # ============================================================== state

    def apply(self, state: dict) -> None:
        """Bring the mixer in line with the page's workspace (see server.py for the shape)."""
        self.swap_on_take = bool(state.get("swapOnTake", True))
        if state.get("transition"):
            t = state["transition"]
            self.transition = {"type": t.get("type", "mix"), "duration": max(0, int(t.get("duration", 1000)))}
        if "audio" in state:
            a = state["audio"] or {}
            self.audio = {"channels": a.get("channels") or {}, "masterDb": float(a.get("masterDb") or 0),
                          "ftbAudio": a.get("ftbAudio", True) is not False}
            self._apply_master()
        if "sources" in state:
            self._sync_sources(state["sources"] or [])
        if "scenes" in state:
            self._sync_scenes(state["scenes"] or {})
        if "overlays" in state:
            self._sync_overlays(state["overlays"] or [])
        self._apply_audio()
        self.notify()

    def _sync_sources(self, sources: list[dict]) -> None:
        wanted = {s["id"]: s for s in sources if s.get("id")}
        for sid in list(self.sources):
            if sid not in wanted:
                self._remove_source(sid)
        for s in sources:
            if s.get("id") and s["id"] not in self.sources:
                self._add_source(s)
            elif s.get("id"):
                self.sources[s["id"]]["name"] = s.get("name", s["id"])
        self.order = [s["id"] for s in sources if s.get("id")]
        self._layout_tiles()

    def _sync_scenes(self, scenes: dict) -> None:
        old = self.scenes
        self.scenes = dict(scenes)
        changed = {k for k in set(old) | set(scenes) if old.get(k) != scenes.get(k)}
        if self.programme in changed and not self.trans:
            if self.programme in self.scenes:
                self._replace_pgm(self.programme)
        if self.preview in changed:
            self._rebuild_preview()

    def _sync_overlays(self, overlays: list[dict]) -> None:
        wanted = {o["id"]: o for o in overlays if o.get("id")}
        for oid in list(self.overlays):
            if oid not in wanted:
                self._remove_overlay(oid)
        for i, o in enumerate(overlays):
            if not o.get("id"):
                continue
            cur = self.overlays.get(o["id"])
            geom = tuple(o.get(k) for k in ("x", "y", "w", "h"))
            if cur is None or cur["geom"] != geom:
                on = cur["on"] if cur else False
                v = cur["v"] if cur else 0.0
                if cur:
                    self._remove_overlay(o["id"])
                self._add_overlay(o, Z_KEYS + i, on, v)
            else:
                cur["render"] = o
                if cur["key"] != o.get("key") and o.get("key"):
                    cur["key"] = o["key"]
                    data = self.gfx(o["key"])
                    if data:
                        self._push_overlay(cur, data)
                self._apply_key(cur)

    def on_gfx(self, key: str, data: bytes) -> None:
        """A graphic arrived from the page: show it wherever it is used."""
        for b in (self.pgm_bin, self.pvw_bin, self.pending, (self.trans or {}).get("bin")):
            if b is not None:
                b.push_gfx(key, data)
        for ov in self.overlays.values():
            if ov["key"] == key:
                self._push_overlay(ov, data)

    # ============================================================ sources

    def _add_source(self, s: dict) -> None:
        sid = s["id"]
        ingest = SourceIngest(sid, self.source_url(sid), self.fmt, lambda sid=sid: self._source_changed(sid))
        entry = {"name": s.get("name", sid), "ingest": ingest, "elements": [], "tile_pad": None,
                 "amix_pad": None, "volume": None}
        # Tile on the multiview.
        tsrc = make("intervideosrc", channel=video_channel(sid), timeout=Gst.SECOND)
        tcaps = make("capsfilter", caps=Gst.Caps.from_string(self.fmt.caps()))
        tq = make("queue", max_size_buffers=2, max_size_bytes=0, max_size_time=0, leaky=2)
        # Audio strip.
        asrc = make("interaudiosrc", channel=audio_channel(sid))
        acaps = make("capsfilter", caps=Gst.Caps.from_string(AUDIO_CAPS))
        vol = make("volume", volume=0.0)
        lvl = make("level", name=f"lvl-{sid}", interval=100_000_000, post_messages=True)
        aq = make("queue", max_size_time=500_000_000, max_size_buffers=0, max_size_bytes=0, leaky=2)
        elements = [tsrc, tcaps, tq, asrc, acaps, vol, lvl, aq]
        for e in elements:
            self.pipeline.add(e)
        tsrc.link(tcaps), tcaps.link(tq)
        asrc.link(acaps), acaps.link(vol), vol.link(lvl), lvl.link(aq)
        entry["tile_pad"] = self.mv.request_pad_simple("sink_%u")
        tq.get_static_pad("src").link(entry["tile_pad"])
        entry["tile_pad"].set_property("alpha", 0.0)
        entry["amix_pad"] = self.amix.request_pad_simple("sink_%u")
        aq.get_static_pad("src").link(entry["amix_pad"])
        entry["volume"] = vol
        entry["elements"] = elements
        for e in elements:
            e.sync_state_with_parent()
        self.sources[sid] = entry
        ingest.start()

    def _remove_source(self, sid: str) -> None:
        entry = self.sources.pop(sid, None)
        if entry is None:
            return
        entry["ingest"].stop()
        for e in entry["elements"]:
            e.set_state(Gst.State.NULL)
        for pad, comp in ((entry["tile_pad"], self.mv), (entry["amix_pad"], self.amix)):
            peer = pad.get_peer()
            if peer is not None:
                peer.unlink(pad)
            comp.release_request_pad(pad)
        for e in entry["elements"]:
            self.pipeline.remove(e)

    def _layout_tiles(self) -> None:
        for sid, entry in self.sources.items():
            idx = self.order.index(sid) if sid in self.order else -1
            pad = entry["tile_pad"]
            if 0 <= idx < MV_TILES:
                x, y, w, h = mv_tile_rect(idx)
                size = self.src_size(sid)
                if size:  # sources arrive stretched to 16:9; show them in their own shape
                    s = min(w / size[0], h / size[1])
                    tw, th = max(2, round(size[0] * s)), max(2, round(size[1] * s))
                    x, y, w, h = x + (w - tw) // 2, y + (h - th) // 2, tw, th
                for k, v in (("xpos", x), ("ypos", y), ("width", w), ("height", h), ("alpha", 1.0)):
                    pad.set_property(k, v)
            else:
                pad.set_property("alpha", 0.0)

    def kick_source(self, sid: str) -> None:
        entry = self.sources.get(sid)
        if entry:
            entry["ingest"].kick()

    def src_size(self, sid: str) -> tuple[int, int] | None:
        entry = self.sources.get(sid)
        info = entry["ingest"].info if entry else {}
        if info.get("width") and info.get("height"):
            return info["width"], info["height"]
        return None

    def _source_changed(self, sid: str) -> None:
        self._layout_tiles()
        for b in (self.pgm_bin, self.pvw_bin, (self.trans or {}).get("bin")):
            if b is not None and sid in b.sources():
                b.refresh_geometry()
        self.notify()

    # ============================================================= scenes

    def _bin(self, shot: str | None, preview: bool, wipe: bool = False) -> SceneBin:
        scene = self.scenes.get(shot or "") or {"id": "empty", "layers": []}
        size = MV_BIG if preview else (self.fmt.width, self.fmt.height)
        return SceneBin(scene, size, self.fmt, MV_FPS if preview else self.fmt.fps, self.src_size, self.gfx, wipe)

    def _rebuild_preview(self) -> None:
        old = self.pvw_bin
        new = self._bin(self.preview, True)
        new.attach(self.pipeline, self.pvw, Z_SCENE + 1, 0.0)
        self.pvw_bin = new

        def ready() -> None:
            if self.pvw_bin is not new:
                return
            new.set(alpha=1.0, zorder=Z_SCENE)
            if old is not None:
                old.detach(self.pipeline, self.pvw)

        new.when_ready(ready)

    def _replace_pgm(self, shot: str | None, after: Callable[[], None] | None = None) -> None:
        """Put `shot` on Programme at its next frame, without a transition."""
        if self.pending is not None:
            self.pending.detach(self.pipeline, self.pgm)
        new = self._bin(shot, False)
        new.attach(self.pipeline, self.pgm, Z_ENTER, 0.0)
        self.pending = new

        def ready() -> None:
            if self.pending is not new:
                return
            self.pending = None
            old = self.pgm_bin
            new.set(alpha=1.0, zorder=Z_SCENE)
            self.pgm_bin = new
            if old is not None:
                old.detach(self.pipeline, self.pgm)
            if after:
                after()
            self.notify()

        new.when_ready(ready)

    def set_preview(self, shot: str | None) -> None:
        if shot == self.preview:
            return
        self.preview = shot
        self._rebuild_preview()
        self.notify()

    def cut(self) -> None:
        if self.trans:
            return self._complete()
        if not self.preview:
            return
        old, new = self.programme, self.preview
        self.programme = new
        if self.swap_on_take and old:
            self.preview = old
        self._apply_audio()
        self._replace_pgm(new)
        if self.preview != new:
            self._rebuild_preview()
        self.notify()

    def auto(self) -> None:
        if self.trans or not self.preview:
            return
        if self.preview == self.programme and self.transition["type"] != "dip":
            return self.cut()
        self._begin(manual=False, pos=0.0)

    def tbar(self, pos: float) -> None:
        pos = max(0.0, min(1.0, float(pos)))
        if not self.trans:
            if pos <= 0 or not self.preview:
                return
            self._begin(manual=True, pos=pos)
        if not self.trans["manual"]:
            return
        self.trans["pos"] = pos
        if pos >= 1:
            self._complete()
        elif pos <= 0:
            self._abort()
        else:
            self._render_transition()

    def _begin(self, manual: bool, pos: float) -> None:
        kind = self.transition["type"]
        new = self._bin(self.preview, False, wipe=(kind == "wipe"))
        new.attach(self.pipeline, self.pgm, Z_ENTER, 0.0)
        self.trans = {"from": self.programme, "to": self.preview, "type": kind,
                      "dur": max(1, self.transition["duration"]) / 1000.0, "start": None,
                      "manual": manual, "pos": pos, "bin": new, "p": 0.0}
        t = self.trans

        def ready() -> None:
            if self.trans is not t:
                return
            t["start"] = time.monotonic()
            self._ensure_tick()

        new.when_ready(ready)
        self.notify()

    def _render_transition(self) -> None:
        t = self.trans
        if t is None or t["start"] is None:
            return
        if t["manual"]:
            p = t["pos"]
        else:
            raw = (time.monotonic() - t["start"]) / t["dur"]
            if raw >= 1:
                return self._complete()
            p = ease(raw)
        t["p"] = p
        new, old = t["bin"], self.pgm_bin
        W = self.fmt.width
        kind = t["type"]
        old_w, new_w = 1 - p, p
        if kind == "dip":
            if p < 0.5:
                old and old.set(alpha=1 - 2 * p)
                new.set(alpha=0.0)
                old_w, new_w = 1 - 2 * p, 0.0
            else:
                old and old.set(alpha=0.0)
                new.set(alpha=2 * p - 1)
                old_w, new_w = 0.0, 2 * p - 1
        elif kind == "wipe":
            new.set(alpha=1.0)
            new.set_wipe(p)
        elif kind == "push":
            old and old.set(xpos=round(-W * p))
            new.set(alpha=1.0, xpos=round(W * (1 - p)))
        else:  # mix
            new.set(alpha=p)
        self._apply_audio({"from": t["from"], "to": t["to"], "old": old_w, "new": new_w})
        self.notify()

    def _complete(self) -> None:
        t, self.trans = self.trans, None
        if t is None:
            return
        new, old = t["bin"], self.pgm_bin
        new.set(alpha=1.0, xpos=0, zorder=Z_SCENE)
        new.set_wipe(1.0)
        self.pgm_bin = new
        if old is not None:
            old.detach(self.pipeline, self.pgm)
        self.programme = t["to"]
        if self.swap_on_take and t["from"]:
            self.preview = t["from"]
            self._rebuild_preview()
        self._apply_audio()
        self.notify()

    def _abort(self) -> None:
        t, self.trans = self.trans, None
        if t is None:
            return
        t["bin"].detach(self.pipeline, self.pgm)
        if self.pgm_bin is not None:
            self.pgm_bin.set(alpha=1.0, xpos=0)
        self._apply_audio()
        self.notify()

    # ================================================================ FTB

    def toggle_ftb(self) -> None:
        f = self.ftb
        black = not f["black"]
        self.ftb = {"black": black, "v": f["v"], "from": f["v"], "to": 1.0 if black else 0.0,
                    "start": time.monotonic(), "dur": max(1, self.transition["duration"]) / 1000.0}
        self._ensure_tick()
        self.notify()

    def _render_ftb(self) -> bool:
        f = self.ftb
        if f["v"] == f["to"]:
            return False
        q = min(1.0, (time.monotonic() - f["start"]) / f["dur"])
        f["v"] = f["from"] + (f["to"] - f["from"]) * q
        self.pgm.get_static_pad("sink_0").set_property("alpha", f["v"])
        self._apply_master()
        if q >= 1:
            f["v"] = f["to"]
            self.notify()
        return f["v"] != f["to"]

    # =============================================================== keys

    def _overlay_chain(self, comp: Gst.Element, fps: int, rect, z: int) -> dict:
        appsrc = make("appsrc", is_live=True, format=3, do_timestamp=True, caps=Gst.Caps.from_string("image/png"))
        chain = [appsrc, make("pngdec"), make("videoconvert"),
                 make("capsfilter", caps=Gst.Caps.from_string("video/x-raw,format=AYUV")),
                 make("imagefreeze", is_live=True, allow_replace=True),
                 make("capsfilter", caps=Gst.Caps.from_string(f"video/x-raw,framerate={fps}/1")),
                 make("queue", max_size_buffers=2, max_size_bytes=0, max_size_time=0, leaky=2)]
        for e in chain:
            self.pipeline.add(e)
        for a, b in zip(chain, chain[1:]):
            a.link(b)
        pad = comp.request_pad_simple("sink_%u")
        chain[-1].get_static_pad("src").link(pad)
        x, y, w, h = rect
        for k, v in (("xpos", x), ("ypos", y), ("width", w), ("height", h), ("zorder", z), ("alpha", 0.0)):
            pad.set_property(k, v)
        for e in chain:
            e.sync_state_with_parent()
        return {"appsrc": appsrc, "elements": chain, "pad": pad, "comp": comp}

    def _add_overlay(self, o: dict, z: int, on: bool, v: float) -> None:
        def rect(W: int, H: int):
            return (round(float(o.get("x", 0)) * W), round(float(o.get("y", 0)) * H),
                    max(1, round(float(o.get("w", 1)) * W)), max(1, round(float(o.get("h", 1)) * H)))

        ov = {"render": o, "key": o.get("key"), "geom": tuple(o.get(k) for k in ("x", "y", "w", "h")),
              "on": on, "v": v, "from": v, "to": 1.0 if on else 0.0, "start": 0.0, "dur": 0.5,
              "chains": [self._overlay_chain(self.pgm, self.fmt.fps, rect(self.fmt.width, self.fmt.height), z),
                         self._overlay_chain(self.pvw, MV_FPS, rect(*MV_BIG), z)]}
        self.overlays[o["id"]] = ov
        data = self.gfx(ov["key"]) if ov["key"] else None
        if data:
            self._push_overlay(ov, data)
        self._apply_key(ov)

    def _remove_overlay(self, oid: str) -> None:
        ov = self.overlays.pop(oid, None)
        if not ov:
            return
        for ch in ov["chains"]:
            for e in ch["elements"]:
                e.set_state(Gst.State.NULL)
            ch["elements"][-1].get_static_pad("src").unlink(ch["pad"])
            ch["comp"].release_request_pad(ch["pad"])
            for e in ch["elements"]:
                self.pipeline.remove(e)

    def _push_overlay(self, ov: dict, data: bytes) -> None:
        for ch in ov["chains"]:
            ch["appsrc"].emit("push-buffer", Gst.Buffer.new_wrapped(data))

    def _apply_key(self, ov: dict) -> None:
        a = max(0.0, min(1.0, ov["v"])) * float(ov["render"].get("opacity", 1))
        for ch in ov["chains"]:
            ch["pad"].set_property("alpha", a)

    def set_key(self, oid: str, on: bool, dur_ms: int = 500) -> None:
        ov = self.overlays.get(oid)
        if ov is None or ov["on"] == on:
            return
        ov.update(on=on, **{"from": ov["v"]}, to=1.0 if on else 0.0, start=time.monotonic(),
                  dur=max(1, dur_ms) / 1000.0)
        self._ensure_tick()
        self.notify()

    def _render_keys(self) -> bool:
        busy = False
        now = time.monotonic()
        for ov in self.overlays.values():
            if ov["v"] == ov["to"]:
                continue
            q = min(1.0, (now - ov["start"]) / ov["dur"])
            ov["v"] = ov["from"] + (ov["to"] - ov["from"]) * q
            if q >= 1:
                ov["v"] = ov["to"]
            else:
                busy = True
            self._apply_key(ov)
        return busy

    # ============================================================== ticks

    def _ensure_tick(self) -> None:
        if self._tick is None:
            self._tick = GLib.timeout_add(TICK_MS, self._on_tick)

    def _on_tick(self) -> bool:
        busy = False
        if self.trans and self.trans["start"] is not None and not self.trans["manual"]:
            self._render_transition()
            busy = self.trans is not None
        elif self.trans and self.trans["manual"]:
            self._render_transition()
        busy = self._render_ftb() or busy
        busy = self._render_keys() or busy
        if not busy:
            self._tick = None
        return busy

    # ============================================================== audio

    def _scene_sources(self, shot: str | None) -> set[str]:
        scene = self.scenes.get(shot or "")
        if not scene:
            return set()
        return {l["src"] for l in scene.get("layers") or []
                if l.get("t") == "video" and l.get("src") and float(l.get("opacity", 1)) > 0}

    def _apply_audio(self, mix: dict | None = None) -> None:
        if self.pipeline is None:
            return
        if mix:
            weights: dict[str, float] = {}
            for sid in self._scene_sources(mix["from"]):
                weights[sid] = max(weights.get(sid, 0), mix["old"])
            for sid in self._scene_sources(mix["to"]):
                weights[sid] = max(weights.get(sid, 0), mix["new"])
        else:
            weights = {sid: 1.0 for sid in self._scene_sources(self.programme)}
        for sid, entry in self.sources.items():
            ch = self.audio["channels"].get(sid) or {}
            mode = ch.get("mode", "afv")
            if ch.get("muted") or mode == "off":
                g = 0.0
            else:
                g = db_to_gain(float(ch.get("db", 0)))
                if mode == "afv":
                    g *= weights.get(sid, 0.0)
            entry["volume"].set_property("volume", g)

    def _apply_master(self) -> None:
        if self.pipeline is None:
            return
        self.pipeline.get_by_name("master").set_property("volume", db_to_gain(self.audio["masterDb"]))
        ftb = 1.0 - self.ftb["v"] if self.audio["ftbAudio"] else 1.0
        self.pipeline.get_by_name("ftbvol").set_property("volume", max(0.0, ftb))

    # ============================================================= status

    def snapshot(self) -> dict:
        t = self.trans
        return {
            "programme": self.programme,
            "preview": self.preview,
            "transition": {"active": t is not None, "type": t["type"] if t else None,
                           "p": round(t["p"], 3) if t else 0, "manual": bool(t and t["manual"])},
            "ftb": {"black": self.ftb["black"], "v": round(self.ftb["v"], 3)},
            "keys": {oid: ov["on"] for oid, ov in self.overlays.items()},
            "sources": {sid: {**e["ingest"].snapshot(), "tile": self.order.index(sid) if sid in self.order and self.order.index(sid) < MV_TILES else None}
                        for sid, e in self.sources.items()},
            "format": {"width": self.fmt.width, "height": self.fmt.height, "fps": self.fmt.fps},
            "fps": self.fps,
            "kbps": self.kbps,
            "encoder": self.encoder.name,
            "publishing": {p.name: p.connected for p in self.publishers},
        }

    def notify(self) -> None:
        if not self._dirty:
            self._dirty = True
            GLib.idle_add(self._flush)

    def _flush(self) -> bool:
        self._dirty = False
        self.on_status(self.snapshot())
        return False

    def _status_tick(self) -> bool:
        self.notify()
        return True

    def _count_frame(self, _pad, _info):
        self.fps_count += 1
        return Gst.PadProbeReturn.OK

    def _count_encoded(self, _pad, _info, name):
        self.enc_count[name] += 1
        return Gst.PadProbeReturn.OK

    def _fps_tick(self) -> bool:
        self.fps, self.fps_count = float(self.fps_count), 0
        stalled = self.fps > 0 and min(self.enc_count.values()) == 0
        self.enc_stalled = self.enc_stalled + 1 if stalled else 0
        self.enc_count = dict.fromkeys(self.enc_count, 0)
        return True

    def _on_message(self, _bus, msg: Gst.Message) -> None:
        if msg.type == Gst.MessageType.ELEMENT:
            s = msg.get_structure()
            if s is None or s.get_name() != "level":
                return
            name = msg.src.get_name()
            rms = [level_db(v) for v in s.get_value("rms")]
            peak = [level_db(v) for v in s.get_value("peak")]
            if name == "lvlm":
                self.meters["master"] = {"rms": rms, "peak": peak}
                self.on_meters(self.meters)
                self.meters = {"sources": {}, "master": None}
            elif name.startswith("lvl-"):
                self.meters["sources"][name[4:]] = {"rms": rms, "peak": peak}
        elif msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            log.error("mixer pipeline error from %s: %s (%s)", msg.src.get_name(), err.message, dbg)
        elif msg.type == Gst.MessageType.WARNING:
            w, _ = msg.parse_warning()
            log.warning("mixer pipeline warning from %s: %s", msg.src.get_name(), w.message)
