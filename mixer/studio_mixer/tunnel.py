"""An https address for the mixer through a Cloudflare quick tunnel.

A studio page is served over https, and browsers block it from calling plain
http addresses other than localhost. So a mixer on another computer (or one a
phone should reach) needs an https address. `cloudflared tunnel --url` gives
one without an account, a domain or router setup: a random
https://<words>.trycloudflare.com that forwards to this mixer's HTTP port.

Only HTTP and WebSockets go through the tunnel (pairing, control, WHIP/WHEP
signaling). WebRTC media still flows directly, and SRT/RTMP senders still need
the mixer's own address and ports. The address changes when the tunnel
restarts; the mixer reports the current one in /api/info and on its page.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def find_cloudflared(explicit: str | None, app_dir: Path) -> str | None:
    if explicit:
        return explicit
    exe = "cloudflared.exe" if sys.platform == "win32" else "cloudflared"
    for cand in (app_dir / "bin" / exe, app_dir.parent / "bin" / exe):
        if cand.exists():
            return str(cand)
    found = shutil.which("cloudflared")
    if found:
        return found
    if sys.platform == "win32":
        for cand in (Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "cloudflared" / exe,
                     Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "cloudflared" / exe,
                     Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / exe):
            if cand.exists():
                return str(cand)
    return None


class Tunnel:
    """Runs cloudflared for as long as the mixer runs, restarting it if it stops."""

    def __init__(self, binary: str | None, port: int, on_change=None) -> None:
        self.binary = binary
        self.port = port
        self.on_change = on_change or (lambda: None)
        self.url: str | None = None
        self.state = "off" if not binary else "starting"
        self.error: str | None = None if binary else "cloudflared is not installed"
        self._proc: subprocess.Popen | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        if not self.binary:
            log.info("No https address: cloudflared is not installed (run the mixer setup again to add it).")
            return
        threading.Thread(target=self._run, name="tunnel", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()

    def _set(self, state: str, url: str | None, error: str | None = None) -> None:
        changed = (state, url) != (self.state, self.url)
        self.state, self.url, self.error = state, url, error
        if changed:
            self.on_change()

    def _run(self) -> None:
        delay = 2.0
        while not self._stop.is_set():
            started = time.time()
            self._set("starting", None)
            try:
                flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
                self._proc = subprocess.Popen(
                    [self.binary, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{self.port}"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace",
                    creationflags=flags)
            except OSError as exc:
                self._set("error", None, str(exc))
                log.warning("Could not start cloudflared: %s", exc)
                return
            last = ""
            for line in self._proc.stderr:  # cloudflared logs to stderr
                line = line.strip()
                if not line:
                    continue
                m = URL_RE.search(line)
                if m and self.url != m.group(0):
                    log.info("https address: %s", m.group(0))
                    self._set("on", m.group(0))
                    delay = 2.0
                elif " ERR " in line:
                    last = line
            self._proc.wait()
            if self._stop.is_set():
                break
            # Quick tunnels sometimes fail to register (rate limits, no network): try again, slower each time.
            self._set("error", None, (last.split(" ERR ", 1)[-1] if last else f"cloudflared stopped (code {self._proc.returncode})"))
            log.warning("Tunnel stopped (%s); retrying in %.0f s", self.error, delay)
            if time.time() - started > 60:
                delay = 2.0
            self._stop.wait(delay)
            delay = min(delay * 2, 120)
        self._set("off", None)
