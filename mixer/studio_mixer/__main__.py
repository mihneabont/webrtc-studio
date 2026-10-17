"""Start the mixer: python -m studio_mixer [--data DIR] [--port 8788] [--mediamtx PATH] [--ffmpeg PATH]"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import shutil
import sys
from pathlib import Path

from .config import Ports, Settings, Store, default_data_dir
from .server import Mixer, serve
from .tunnel import find_cloudflared

HERE = Path(__file__).resolve().parent


def find_mediamtx(explicit: str | None) -> str:
    if explicit:
        return explicit
    exe = "mediamtx.exe" if sys.platform == "win32" else "mediamtx"
    for cand in (HERE.parent / "bin" / exe, HERE.parent.parent / "bin" / exe):
        if cand.exists():
            return str(cand)
    return shutil.which("mediamtx") or exe


def main() -> None:
    ap = argparse.ArgumentParser(prog="studio-mixer")
    ap.add_argument("--data", type=Path, default=Path(os.environ.get("MIXER_DATA") or default_data_dir()))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MIXER_PORT", 8788)))
    ap.add_argument("--mediamtx", default=os.environ.get("MIXER_MEDIAMTX"))
    ap.add_argument("--ffmpeg", default=os.environ.get("MIXER_FFMPEG"))
    ap.add_argument("--host", default=os.environ.get("MIXER_PUBLIC_HOST"), help="public address for WebRTC")
    ap.add_argument("--encoder", default=os.environ.get("MIXER_ENCODER"), help="force a GStreamer H.264 encoder")
    ap.add_argument("--cloudflared", default=os.environ.get("MIXER_CLOUDFLARED"), help="path to cloudflared")
    ap.add_argument("--no-tunnel", action="store_true", default=os.environ.get("MIXER_TUNNEL", "1") == "0",
                    help="don't open an https address through a Cloudflare quick tunnel")
    args = ap.parse_args()

    args.data.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [logging.FileHandler(args.data / "mixer.log", encoding="utf-8")]
    if sys.stderr is not None:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), handlers=handlers,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings(data_dir=args.data, ports=Ports(http=args.port), mediamtx_bin=find_mediamtx(args.mediamtx),
                        ffmpeg_bin=args.ffmpeg, public_host=args.host, encoder=args.encoder,
                        cloudflared_bin=find_cloudflared(args.cloudflared, HERE.parent), tunnel=not args.no_tunnel)
    mixer = Mixer(settings, Store(args.data / "mixer.json"))
    try:
        asyncio.run(serve(mixer))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
