"""Outputs: ffmpeg copies the programme from MediaMTX to RTMP, SRT or WHIP destinations.

The programme is encoded once by the mixing pipeline. Each output is one
ffmpeg process that reads it back over local RTSP and passes the video
through untouched (only the audio is converted to what the protocol wants),
so an extra output costs almost no CPU. An output that drops reconnects on
its own with a growing pause, until the operator stops it.
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

TWITCH_RTMP = "rtmps://ingest.global-contribute.live-video.net/app"


def find_ffmpeg(explicit: str | None = None) -> str | None:
    exe = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    cands = [explicit, os.environ.get("FFMPEG"), str(Path(sys.prefix) / "bin" / exe)]
    if found := shutil.which(exe):
        cands.append(found)
    if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        wg = Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "WinGet"
        cands.append(str(wg / "Links" / exe))
        try:
            for pkg in (wg / "Packages").iterdir():
                if "ffmpeg" in pkg.name.lower():
                    cands += [str(p / "bin" / exe) for p in pkg.iterdir()]
        except OSError:
            pass
    return next((c for c in cands if c and Path(c).is_file()), None)


def mask(url: str) -> str:
    """Hide stream keys and passwords in what we log and show."""
    url = re.sub(r"(streamid=[^:&]*:[^:&]*:[^:&]*:)[^&]*", r"\1••••", url)
    url = re.sub(r"(passphrase=)[^&]*", r"\1••••", url)
    return re.sub(r"^(rtmps?://[^/]+/[^/?]+/).+$", r"\1••••", url)


class Output:
    def __init__(self, cfg: dict, source_url: str, ffmpeg: str | None, on_change, has_video=lambda: True) -> None:
        self.has_video = has_video
        self.cfg = cfg
        self.source_url = source_url
        self.ffmpeg = ffmpeg
        self.on_change = on_change
        self.want = False
        self.proc: subprocess.Popen | None = None
        self._waiting = False
        self.state = "idle"  # idle, connecting, live, retrying, error
        self.error: str | None = None
        self.kbps = 0.0
        self.live_since: float | None = None
        self.restarts = 0
        self._lock = threading.Lock()
        self._backoff = 2.0

    # ------------------------------------------------------------- commands

    def _argv(self) -> list[str]:
        c = self.cfg
        kind = c.get("kind")
        url = (c.get("url") or "").strip()
        key = (c.get("key") or "").strip()
        head = [self.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-stats_period", "1",
                "-rtsp_transport", "tcp", "-i", self.source_url, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy"]
        if kind in ("rtmp", "twitch"):
            if kind == "twitch":
                url = TWITCH_RTMP
            if not re.match(r"^rtmps?://[^\s/]+/\S*$", url):
                raise ValueError("Enter an rtmp:// or rtmps:// server URL.")
            if key:
                url = url.rstrip("/") + "/" + key
            return head + ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
                           "-flvflags", "no_duration_filesize", "-f", "flv", url]
        if kind == "srt":
            if not url.startswith("srt://"):
                raise ValueError("Enter an srt:// address.")
            return head + ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-f", "mpegts", url]
        if kind == "whip":
            if not re.match(r"^https?://", url):
                raise ValueError("Enter the WHIP endpoint URL (https://...).")
            auth = ["-authorization", key] if key else []
            return head + ["-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2", *auth, "-f", "whip", url]
        raise ValueError(f"unknown output kind {kind!r}")

    def start(self) -> None:
        self.want = True
        self._backoff = 2.0
        self.error = None
        self._spawn()

    def stop(self) -> None:
        self.want = False
        self._kill()
        self.state = "idle"
        self.live_since = None
        self.kbps = 0.0
        self.on_change()

    def update(self, cfg: dict) -> None:
        restart = self.want and any(cfg.get(k) != self.cfg.get(k) for k in ("kind", "url", "key"))
        self.cfg = cfg
        if restart:
            self._kill()
            self._spawn()

    def snapshot(self) -> dict:
        return {"state": self.state, "error": self.error, "kbps": round(self.kbps),
                "live_since": self.live_since, "restarts": self.restarts, "hasKey": bool(self.cfg.get("key"))}

    # ------------------------------------------------------------- process

    def _spawn(self) -> None:
        if not self.ffmpeg:
            self.state, self.error = "error", "ffmpeg is not installed on the mixer computer. Run the mixer installer again."
            self.want = False
            self.on_change()
            return
        try:
            argv = self._argv()
        except ValueError as e:
            self.state, self.error = "error", str(e)
            self.want = False
            self.on_change()
            return
        if not self.has_video():
            # The engine is (re)starting or not encoding yet: ffmpeg would fail with "map 0:v:0".
            with self._lock:
                self.proc = None  # an earlier ffmpeg has exited; nothing runs while waiting
                if self._waiting:
                    return
                self._waiting = True
            self.state, self.error = "connecting", "Waiting for the programme video from the mixing engine…"
            self.on_change()
            threading.Timer(1.0, self._wait_video).start()
            return
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        with self._lock:
            self.proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, creationflags=flags)
            proc = self.proc
        self.state = "connecting"
        self.on_change()
        log.info("output %s -> %s", self.cfg.get("id"), mask(argv[-1]))
        threading.Thread(target=self._read_progress, args=(proc,), daemon=True).start()
        threading.Thread(target=self._read_errors, args=(proc, argv[-1]), daemon=True).start()

    def _kill(self) -> None:
        with self._lock:
            proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(3)
            except subprocess.TimeoutExpired:
                proc.kill()

    def _read_progress(self, proc: subprocess.Popen) -> None:
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            k, _, v = line.partition("=")
            if k == "bitrate":
                try:
                    self.kbps = float(v.replace("kbits/s", ""))
                except ValueError:
                    pass
            elif k == "progress" and self.proc is proc:
                if self.state != "live" and self.kbps > 0:
                    self.state, self.live_since, self.error = "live", time.time(), None
                    self._backoff = 2.0
                    self.on_change()
        code = proc.wait()
        if self.proc is not proc:
            return  # stopped or replaced on purpose
        self.live_since = None
        self.kbps = 0.0
        if self.want:
            self.restarts += 1
            self.state = "retrying"
            if not self.error:
                self.error = f"ffmpeg stopped (exit {code})"
            self.on_change()
            delay, self._backoff = self._backoff, min(self._backoff * 2, 30.0)
            threading.Timer(delay, self._retry, args=(proc,)).start()
        else:
            self.state = "idle"
            self.on_change()

    def _wait_video(self) -> None:
        with self._lock:
            self._waiting = False
        if self.want and self.proc is None:
            self._spawn()

    def _retry(self, old: subprocess.Popen) -> None:
        if self.want and self.proc is old:
            self._spawn()

    def _read_errors(self, proc: subprocess.Popen, url: str) -> None:
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").strip().replace(url, mask(url))
            line = re.sub(r"^\[[^\]]*\]\s*", "", line)
            if line:
                self.error = line[:300]
                log.info("output %s: %s", self.cfg.get("id"), self.error)


class Outputs:
    def __init__(self, source_url: str, ffmpeg: str | None, on_change, has_video=lambda: True) -> None:
        self.source_url = source_url
        self.has_video = has_video
        self.ffmpeg = ffmpeg
        self.on_change = on_change
        self.items: dict[str, Output] = {}

    def sync(self, configs: list[dict]) -> None:
        wanted = {c["id"]: c for c in configs if c.get("id")}
        for oid in list(self.items):
            if oid not in wanted:
                self.items.pop(oid).stop()
        for oid, cfg in wanted.items():
            if oid in self.items:
                self.items[oid].update(cfg)
            else:
                self.items[oid] = Output(cfg, self.source_url, self.ffmpeg, self.on_change, self.has_video)

    def start(self, oid: str) -> None:
        if oid in self.items:
            self.items[oid].start()

    def stop(self, oid: str) -> None:
        if oid in self.items:
            self.items[oid].stop()

    def stop_all(self) -> None:
        for o in self.items.values():
            if o.want:
                o.stop()

    def snapshot(self) -> dict:
        return {oid: o.snapshot() for oid, o in self.items.items()}
