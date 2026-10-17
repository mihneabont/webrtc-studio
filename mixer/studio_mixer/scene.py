"""A scene rendered as its own little compositor (a bin), placed on Programme or Preview.

The studio page sends each scene already flattened into an ordered list of
layers of two kinds:

    {"t": "video", "src": <source id>, "x", "y", "w", "h", "fit", "crop": {l,t,r,b}, "opacity"}
    {"t": "gfx", "key": <graphic key>, "x", "y", "w", "h", "opacity"}

Positions are fractions of the frame. Everything that is not live video
(scene background, text, shapes, images, borders, name labels) is drawn by the
page into PNG "gfx" images with the page's own drawing code, so graphics look
the same in browser mode and mixer mode. The mixer only places pictures.

A whole scene in one bin makes every transition a matter of one pad on the
main compositor: alpha for mix and dip, position for push, and an SMPTE alpha
mask inside the bin for wipe.
"""

from __future__ import annotations

import itertools
from typing import Callable

from gi.repository import GLib, Gst

from .media import Format, rgba_hex, video_channel

_ids = itertools.count(1)


def make(factory: str, **props) -> Gst.Element:
    """ElementFactory.make plus properties; force_live is construct-only, so it goes in at creation."""
    if "force_live" in props:
        e = Gst.ElementFactory.make_with_properties(factory, ["force-live"], [bool(props.pop("force_live"))])
    else:
        e = Gst.ElementFactory.make(factory)
    if e is None:
        raise RuntimeError(f"GStreamer element {factory} is missing")
    for k, v in props.items():
        e.set_property(k.replace("_", "-"), v)
    return e


def fit_geometry(layer: dict, src_size: tuple[int, int] | None, W: int, H: int):
    """Crop (pixels of the stretched W x H source frame) and pad rect (pixels of the scene) for one layer.

    Sources arrive stretched to W x H, so a fraction of the source frame is the same fraction of
    the stretched frame; the source's real size only matters for the aspect ratio.
    """
    x, y, w, h = (float(layer.get(k, d)) for k, d in (("x", 0), ("y", 0), ("w", 1), ("h", 1)))
    px, py, pw, ph = x * W, y * H, w * W, h * H
    c = layer.get("crop") or {}
    cl, ct, cr, cb = (min(max(float(c.get(k) or 0), 0.0), 0.95) for k in ("l", "t", "r", "b"))
    sw_real, sh_real = src_size or (16, 9)
    # Visible part of the source after the operator's crop, as fractions and in real pixels.
    fx0, fy0, fx1, fy1 = cl, ct, 1 - cr, 1 - cb
    if fx1 - fx0 <= 0.01 or fy1 - fy0 <= 0.01:
        return None
    vis_w, vis_h = (fx1 - fx0) * sw_real, (fy1 - fy0) * sh_real
    fit = layer.get("fit") or "cover"
    if fit == "cover" and pw > 0 and ph > 0:
        s = max(pw / vis_w, ph / vis_h)
        keep_w, keep_h = (pw / s) / vis_w, (ph / s) / vis_h  # fraction of the visible part that stays
        dx, dy = (1 - keep_w) / 2 * (fx1 - fx0), (1 - keep_h) / 2 * (fy1 - fy0)
        fx0, fx1, fy0, fy1 = fx0 + dx, fx1 - dx, fy0 + dy, fy1 - dy
    elif fit == "contain" and pw > 0 and ph > 0:
        s = min(pw / vis_w, ph / vis_h)
        dw, dh = vis_w * s, vis_h * s
        px, py, pw, ph = px + (pw - dw) / 2, py + (ph - dh) / 2, dw, dh
    crop = (round(fx0 * W), round(fy0 * H), round((1 - fx1) * W), round((1 - fy1) * H))
    rect = (round(px), round(py), max(1, round(pw)), max(1, round(ph)))
    return crop, rect


class SceneBin:
    def __init__(self, scene: dict, size: tuple[int, int], fmt: Format, fps: int,
                 src_size: Callable[[str], tuple[int, int] | None], gfx: Callable[[str], bytes | None],
                 wipe: bool = False) -> None:
        self.scene = scene
        self.W, self.H = size
        self.fmt = fmt  # source frames are fmt.width x fmt.height
        self.fps = fps
        self.src_size = src_size
        self.gfx = gfx
        self.wipe = wipe
        self.bin = Gst.Bin.new(f"scene-{scene.get('id', 'x')}-{next(_ids)}")
        self.layers: list[dict] = []
        self.ready = False
        self._on_ready: Callable[[], None] | None = None
        self._waiting: set[int] = set()  # layers that have not produced a frame yet
        self._deadline = 0
        self._settle = 0
        self.pad: Gst.Pad | None = None  # request pad on the main compositor
        self._build()

    # ------------------------------------------------------------------ build

    def _make(self, factory: str, **props) -> Gst.Element:
        e = make(factory, **props)
        self.bin.add(e)
        return e

    def _chain(self, *elements: Gst.Element) -> None:
        for a, b in zip(elements, elements[1:]):
            if not a.link(b):
                raise RuntimeError(f"cannot link {a.get_name()} to {b.get_name()}")

    def _caps(self, s: str) -> Gst.Element:
        return self._make("capsfilter", caps=Gst.Caps.from_string(s))

    def _build(self) -> None:
        W, H = self.W, self.H
        # Black behind everything; the scene's own background colour is its first layer.
        self.comp = self._make("compositor", background=1, force_live=True)
        out = [self.comp, self._caps(f"video/x-raw,width={W},height={H},framerate={self.fps}/1")]
        if self.wipe:
            out += [self._make("videoconvert"), self._caps("video/x-raw,format=AYUV"),
                    self._make("smptealpha", name="wipe", type=1, invert=True, position=1.0)]
        out.append(self._make("queue", max_size_buffers=3, max_size_bytes=0, max_size_time=0, leaky=2))
        self._chain(*out)
        ghost = Gst.GhostPad.new("src", out[-1].get_static_pad("src"))
        self.bin.add_pad(ghost)
        ghost.add_probe(Gst.PadProbeType.BUFFER, self._out_buffer)

        z = 0
        bg = self.scene.get("bg") or "#000000"
        if rgba_hex(bg) != 0xFF000000:
            self._color_layer(bg, (0, 0, W, H), z)
        for layer in self.scene.get("layers") or []:
            z += 1
            if layer.get("t") == "video" and layer.get("src"):
                self._video_layer(layer, z)
            elif layer.get("t") == "gfx" and layer.get("key"):
                self._gfx_layer(layer, z)

    def _pad(self, upstream: Gst.Element, z: int, rect, alpha: float, wait: bool = True) -> Gst.Pad:
        if wait:
            # The scene counts as ready only once every layer has delivered a picture,
            # so a take never shows a half-built scene.
            self._waiting.add(z)
            upstream.get_static_pad("src").add_probe(
                Gst.PadProbeType.BUFFER, lambda _p, _i, z=z: (self._waiting.discard(z), Gst.PadProbeReturn.REMOVE)[1])
        pad = self.comp.request_pad_simple("sink_%u")
        upstream.get_static_pad("src").link(pad)
        x, y, w, h = rect
        for k, v in (("xpos", x), ("ypos", y), ("width", w), ("height", h), ("zorder", z), ("alpha", alpha)):
            pad.set_property(k, v)
        return pad

    def _color_layer(self, color: str, rect, z: int) -> None:
        src = self._make("videotestsrc", is_live=True, pattern=17, foreground_color=rgba_hex(color))  # solid-color
        caps = self._caps(f"video/x-raw,format=AYUV,width=16,height=16,framerate={self.fps}/1")
        self._chain(src, caps)
        self._pad(caps, z, rect, 1.0)

    def _video_layer(self, layer: dict, z: int) -> None:
        src = self._make("intervideosrc", channel=video_channel(layer["src"]), timeout=Gst.SECOND)
        caps = self._caps(self.fmt.caps())
        crop = self._make("videocrop")
        q = self._make("queue", max_size_buffers=2, max_size_bytes=0, max_size_time=0, leaky=2)
        self._chain(src, caps, crop, q)
        pad = self._pad(q, z, (0, 0, 1, 1), float(layer.get("opacity", 1)))
        self.layers.append({"layer": layer, "crop": crop, "pad": pad})
        self._apply_geometry(self.layers[-1])

    def _gfx_layer(self, layer: dict, z: int) -> None:
        appsrc = self._make("appsrc", is_live=True, format=3, do_timestamp=True,
                            caps=Gst.Caps.from_string("image/png"))
        chain = [appsrc, self._make("pngdec"), self._make("videoconvert"),
                 self._caps("video/x-raw,format=AYUV"),
                 self._make("imagefreeze", is_live=True, allow_replace=True),
                 self._caps(f"video/x-raw,framerate={self.fps}/1"),
                 self._make("queue", max_size_buffers=2, max_size_bytes=0, max_size_time=0, leaky=2)]
        self._chain(*chain)
        W, H = self.W, self.H
        rect = (round(float(layer.get("x", 0)) * W), round(float(layer.get("y", 0)) * H),
                max(1, round(float(layer.get("w", 1)) * W)), max(1, round(float(layer.get("h", 1)) * H)))
        data = self.gfx(layer["key"])
        self._pad(chain[-1], z, rect, float(layer.get("opacity", 1)), wait=bool(data))
        self.layers.append({"layer": layer, "appsrc": appsrc})
        if data:
            self.push_gfx(layer["key"], data)

    # --------------------------------------------------------------- updates

    def push_gfx(self, key: str, data: bytes) -> None:
        for entry in self.layers:
            if entry.get("appsrc") is not None and entry["layer"].get("key") == key:
                entry["appsrc"].emit("push-buffer", Gst.Buffer.new_wrapped(data))

    def sources(self) -> set[str]:
        return {l["src"] for l in self.scene.get("layers") or []
                if l.get("t") == "video" and l.get("src") and float(l.get("opacity", 1)) > 0}

    def refresh_geometry(self) -> None:
        for entry in self.layers:
            if "crop" in entry:
                self._apply_geometry(entry)

    def _apply_geometry(self, entry: dict) -> None:
        layer = entry["layer"]
        # Crop is in source-frame pixels (fmt size); the pad rect in this bin's pixels.
        g = fit_geometry(layer, self.src_size(layer["src"]), self.fmt.width, self.fmt.height)
        if g is None:
            entry["pad"].set_property("alpha", 0.0)
            return
        (cl, ct, cr, cb), (x, y, w, h) = g
        sx, sy = self.W / self.fmt.width, self.H / self.fmt.height
        crop = entry["crop"]
        for k, v in (("left", cl), ("top", ct), ("right", cr), ("bottom", cb)):
            if crop.get_property(k) != v:
                crop.set_property(k, v)
        pad = entry["pad"]
        for k, v in (("xpos", round(x * sx)), ("ypos", round(y * sy)),
                     ("width", max(1, round(w * sx))), ("height", max(1, round(h * sy)))):
            pad.set_property(k, v)

    def set_wipe(self, revealed: float) -> None:
        """0 = nothing of this scene shows, 1 = all of it (left to right)."""
        w = self.bin.get_by_name("wipe")
        if w is not None:
            w.set_property("position", 1.0 - max(0.0, min(1.0, revealed)))

    # ------------------------------------------------------------- lifecycle

    def when_ready(self, cb: Callable[[], None]) -> None:
        if self.ready:
            cb()
        else:
            self._on_ready = cb

    def _out_buffer(self, _pad, _info):
        if self._waiting:
            if not self._deadline:
                self._deadline = GLib.get_monotonic_time() + 1_000_000
            if GLib.get_monotonic_time() < self._deadline:
                return Gst.PadProbeReturn.OK  # a layer is still starting; give it up to a second
        # The compositor needs a few frames to pick up what its layers just delivered.
        self._settle += 1
        if self._settle < 4:
            return Gst.PadProbeReturn.OK
        GLib.idle_add(self._fire_ready)
        return Gst.PadProbeReturn.REMOVE

    def _fire_ready(self) -> bool:
        if not self.ready:
            self.ready = True
            cb, self._on_ready = self._on_ready, None
            if cb:
                cb()
        return False

    def attach(self, pipeline: Gst.Pipeline, comp: Gst.Element, z: int, alpha: float) -> None:
        pipeline.add(self.bin)
        self.pad = comp.request_pad_simple("sink_%u")
        for k, v in (("zorder", z), ("alpha", alpha), ("xpos", 0), ("ypos", 0)):
            self.pad.set_property(k, v)
        self.bin.get_static_pad("src").link(self.pad)
        self.bin.sync_state_with_parent()

    def detach(self, pipeline: Gst.Pipeline, comp: Gst.Element) -> None:
        self.bin.set_state(Gst.State.NULL)
        if self.pad is not None:
            self.bin.get_static_pad("src").unlink(self.pad)
            comp.release_request_pad(self.pad)
            self.pad = None
        pipeline.remove(self.bin)

    def set(self, **props) -> None:
        if self.pad is not None:
            for k, v in props.items():
                self.pad.set_property(k, v)
