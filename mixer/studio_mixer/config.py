"""Settings, ports and the small persisted state (pairing code and paired studios)."""

from __future__ import annotations

import json
import os
import secrets
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path


def default_data_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "StudioMixer"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "studio-mixer"


@dataclass
class Ports:
    # 8788 is where the studio page has always looked for its helper. The rest stay clear of
    # MediaMTX's defaults and of Studio Server (8700-8705), which may run on the same machine.
    http: int = 8788  # control API, WHIP/WHEP for the page and encoders
    rtsp: int = 8790  # MediaMTX RTSP, localhost only: how the engine reads sources
    webrtc: int = 8791  # MediaMTX WHIP/WHEP over HTTP, localhost only (proxied by the API)
    webrtc_udp: int = 8792  # WebRTC media, UDP and TCP
    srt: int = 8793  # SRT in (Larix, OBS, hardware encoders) and the engine's own publishing
    rtmp: int = 8794  # RTMP in
    api: int = 8795  # MediaMTX control API, localhost only


@dataclass
class Settings:
    data_dir: Path
    ports: Ports = field(default_factory=Ports)
    mediamtx_bin: str = "mediamtx"
    ffmpeg_bin: str | None = None
    bind: str = "0.0.0.0"
    public_host: str | None = None
    encoder: str | None = None  # force an encoder, e.g. x264enc
    cloudflared_bin: str | None = None  # https address through a Cloudflare quick tunnel
    tunnel: bool = True


def lan_addresses() -> list[str]:
    """IPv4 addresses other devices can probably reach, best guess first."""
    found: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.0.2.1", 9))
        found.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found and not ip.startswith("127."):
                found.append(ip)
    except OSError:
        pass
    return found or ["127.0.0.1"]


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


class Store:
    """mixer.json: the engine's MediaMTX secret, the current pairing code, the paired studios
    (tokens are stored hashed) and the last workspace a studio sent, so a restart resumes the show."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.data: dict = {}
        if path.exists():
            try:
                self.data = json.loads(path.read_text("utf-8"))
            except ValueError:
                self.data = {}
        d = self.data
        d.setdefault("engine_secret", secrets.token_urlsafe(24))
        d.setdefault("name", socket.gethostname() or "Studio Mixer")
        d.setdefault("pair_code", new_code())
        d.setdefault("clients", [])  # [{id, name, hash, created, last_seen}]
        d.setdefault("workspace", None)
        self.save()

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=2), "utf-8")
            os.replace(tmp, self.path)

    def rotate_code(self) -> None:
        self.data["pair_code"] = new_code()
        self.save()

    def touch(self, client_id: str) -> None:
        for c in self.data["clients"]:
            if c["id"] == client_id:
                c["last_seen"] = time.time()
