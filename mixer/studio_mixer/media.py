"""Media formats, channel names and the choice of H.264 encoder."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from gi.repository import GLib, Gst

log = logging.getLogger(__name__)

AUDIO_CAPS = "audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved"
TS_CAPS = "video/mpegts,systemstream=true,packetsize=188"

# The control page's multiview: Preview and Programme on top, input tiles below.
MV_WIDTH, MV_HEIGHT, MV_FPS = 1280, 720, 25
MV_BIG = (640, 360)
MV_TILE = (320, 180)
MV_COLS = 4
MV_TILES = 8


def mv_tile_rect(index: int) -> tuple[int, int, int, int]:
    col, row = index % MV_COLS, index // MV_COLS
    return col * MV_TILE[0], MV_BIG[1] + row * MV_TILE[1], MV_TILE[0], MV_TILE[1]


@dataclass(frozen=True)
class Format:
    width: int = 1920
    height: int = 1080
    fps: int = 30

    @classmethod
    def from_dict(cls, d: dict | None) -> "Format":
        d = d or {}
        w = int(d.get("width") or 1920)
        h = int(d.get("height") or 1080)
        fps = int(d.get("fps") or 30)
        # Even sizes only: every encoder wants them.
        return cls(max(160, w - w % 2), max(90, h - h % 2), min(max(fps, 10), 60))

    def caps(self, fmt: str = "I420") -> str:
        return (f"video/x-raw,format={fmt},width={self.width},height={self.height},"
                f"framerate={self.fps}/1,pixel-aspect-ratio=1/1")


def video_channel(source_id: str) -> str:
    return f"mixer-v-{source_id}"


def audio_channel(source_id: str) -> str:
    return f"mixer-a-{source_id}"


def rgba_hex(color: str | None, default: int = 0xFF000000) -> int:
    """'#rrggbb' or '#rrggbbaa' -> 0xAARRGGBB for videotestsrc."""
    c = (color or "").lstrip("#")
    try:
        if len(c) == 6:
            return 0xFF000000 | int(c, 16)
        if len(c) == 8:
            return (int(c[6:], 16) << 24) | int(c[:6], 16)
    except ValueError:
        pass
    return default


# ------------------------------------------------------------------ encoders

@dataclass(frozen=True)
class Encoder:
    name: str
    hardware: bool

    def describe(self, kbps: int, gop: int, low_latency: bool = True) -> str:
        """A launch-line fragment: raw video in, H.264 byte-stream out."""
        n = self.name
        if n == "x264enc":
            preset = "veryfast" if kbps >= 3000 else "ultrafast"
            return (f"videoconvert ! video/x-raw,format=I420 ! x264enc bitrate={kbps} key-int-max={gop} "
                    f"bframes=0 tune=zerolatency speed-preset={preset} threads=0 "
                    "option-string=nal-hrd=cbr ! video/x-h264,profile=main")
        if n == "qsvh264enc":
            return (f"videoconvert ! video/x-raw,format=NV12 ! qsvh264enc bitrate={kbps} max-bitrate={kbps} "
                    f"rate-control=cbr gop-size={gop} b-frames=0 ! video/x-h264,profile=main")
        if n == "nvh264enc":
            return (f"videoconvert ! video/x-raw,format=NV12 ! nvh264enc bitrate={kbps} rc-mode=cbr "
                    f"gop-size={gop} bframes=0 zerolatency=true ! video/x-h264,profile=main")
        if n == "amfh264enc":
            return (f"videoconvert ! video/x-raw,format=NV12 ! amfh264enc bitrate={kbps} rate-control=cbr "
                    f"gop-size={gop} b-frames=0 usage=low-latency ! video/x-h264,profile=main")
        if n == "mfh264enc":
            return (f"videoconvert ! video/x-raw,format=NV12 ! mfh264enc bitrate={kbps} rc-mode=cbr "
                    f"gop-size={gop} bframes=0 low-latency=true ! video/x-h264,profile=main")
        raise ValueError(n)


CANDIDATES = [Encoder("qsvh264enc", True), Encoder("nvh264enc", True), Encoder("amfh264enc", True),
              Encoder("mfh264enc", True), Encoder("x264enc", False)]


def _works(enc: Encoder) -> bool:
    if Gst.ElementFactory.find(enc.name) is None:
        return False
    try:
        p = Gst.parse_launch(
            "videotestsrc num-buffers=15 ! video/x-raw,width=1280,height=720,framerate=30/1 ! "
            f"{enc.describe(2000, 30)} ! h264parse ! fakesink"
        )
    except GLib.Error:
        return False
    p.set_state(Gst.State.PLAYING)
    msg = p.get_bus().timed_pop_filtered(10 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    ok = msg is not None and msg.type == Gst.MessageType.EOS
    p.set_state(Gst.State.NULL)
    return ok


def pick_encoder(prefer: str | None = None, skip: set[str] | None = None) -> Encoder:
    """The first encoder that really encodes on this machine (hardware first)."""
    order = [e for e in CANDIDATES if e.name not in (skip or ())]
    if prefer:
        order = [e for e in order if e.name == prefer] + [e for e in order if e.name != prefer]
    for enc in order:
        if _works(enc):
            log.info("video encoder: %s", enc.name)
            return enc
        log.debug("encoder %s not usable", enc.name)
    raise RuntimeError("no working H.264 encoder (x264enc missing?)")
