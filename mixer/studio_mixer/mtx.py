"""Runs the bundled MediaMTX, which receives every source and serves the mixer's streams.

MediaMTX never mixes anything. Sources publish to `in/<source id>` (WHIP from
OBS, Larix or the studio page; SRT; RTMP); the engine reads them over local
RTSP and publishes `program` and `multiview` back over SRT. Every connection
is authorised by the mixer's API (server.py, /internal/mtx-auth): a source
needs its own token, and only the engine (from this machine) may do anything else.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from .config import Settings, lan_addresses

log = logging.getLogger(__name__)

SOURCE_PREFIX = "in/"


def _is_video(track: dict) -> bool:
    return "width" in (track.get("codecProps") or {}) or track.get("codec") in ("VP8", "VP9", "AV1", "H264", "H265")


def source_path(source_id: str) -> str:
    return f"{SOURCE_PREFIX}{source_id}"


def write_config(settings: Settings) -> Path:
    p = settings.ports
    hosts = [settings.public_host] if settings.public_host else []
    hosts += [ip for ip in lan_addresses() if ip not in hosts and not ip.startswith("127.")]
    cfg = {
        "logLevel": "info",
        "logDestinations": ["stdout"],
        "authMethod": "http",
        "authHTTPAddress": f"http://127.0.0.1:{p.http}/internal/mtx-auth",
        "authHTTPExclude": [],
        "api": True,
        "apiAddress": f"127.0.0.1:{p.api}",
        "metrics": False,
        "pprof": False,
        "playback": False,
        "hls": False,
        "rtsp": True,
        "rtspTransports": ["tcp"],
        "rtspAddress": f"127.0.0.1:{p.rtsp}",
        "rtmp": True,
        "rtmpAddress": f":{p.rtmp}",
        "srt": True,
        "srtAddress": f":{p.srt}",
        "webrtc": True,
        "webrtcAddress": f"127.0.0.1:{p.webrtc}",
        "webrtcAllowOrigins": ["*"],
        "webrtcLocalUDPAddress": f":{p.webrtc_udp}",
        "webrtcLocalTCPAddress": f":{p.webrtc_udp}",
        "webrtcIPsFromInterfaces": True,
        "webrtcAdditionalHosts": hosts,
        "webrtcICEServers2": [],
        "pathDefaults": {"overridePublisher": True},
        "paths": {"all_others": {}},
    }
    path = settings.data_dir / "mediamtx.yml"
    path.write_text(json.dumps(cfg, indent=2), "utf-8")  # JSON is valid YAML
    return path


class MediaMTX:
    def __init__(self, settings: Settings, engine_secret: str) -> None:
        self.settings = settings
        self.engine_secret = engine_secret
        self.proc: subprocess.Popen | None = None
        self._stop = threading.Event()
        self.restarts = 0
        self.last_error: str | None = None

    def start(self) -> None:
        self.config_path = write_config(self.settings)
        self._kill_stale()
        threading.Thread(target=self._supervise, name="mediamtx", daemon=True).start()

    def _supervise(self) -> None:
        log_path = self.settings.data_dir / "mediamtx.log"
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                with open(log_path, "ab") as logf:
                    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    self.proc = subprocess.Popen([self.settings.mediamtx_bin, str(self.config_path)],
                                                 stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                                 creationflags=flags, cwd=self.settings.data_dir)  # it writes files next to itself
                    self._pid_file.write_text(str(self.proc.pid))
                    code = self.proc.wait()
            except OSError as exc:
                self.last_error = f"cannot start MediaMTX ({self.settings.mediamtx_bin}): {exc}"
                log.error(self.last_error)
                code = None
            if self._stop.is_set():
                break
            self.restarts += 1
            if code is not None:
                self.last_error = f"MediaMTX exited with code {code}; see {log_path}"
                log.warning(self.last_error)
            self._stop.wait(1 if time.monotonic() - started > 30 else 5)

    def stop(self) -> None:
        self._stop.set()
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    @property
    def _pid_file(self) -> Path:
        return self.settings.data_dir / "mediamtx.pid"

    def _kill_stale(self) -> None:
        """Stop a MediaMTX left behind by a run that was killed (it would hold the ports)."""
        try:
            pid = int(self._pid_file.read_text())
        except (OSError, ValueError):
            return
        try:
            if sys.platform == "win32":
                out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                                     capture_output=True, text=True).stdout
                if "mediamtx" in out.lower():
                    subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
            else:
                cmdline = Path(f"/proc/{pid}/cmdline")
                if cmdline.exists() and b"mediamtx" in cmdline.read_bytes():
                    os.kill(pid, signal.SIGTERM)
                    time.sleep(0.5)
        except OSError:
            pass

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    # ------------------------------------------------------------------ API

    def _get(self, path: str) -> dict:
        req = urllib.request.Request(f"http://127.0.0.1:{self.settings.ports.api}{path}")
        token = base64.b64encode(f"engine:{self.engine_secret}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
        with urllib.request.urlopen(req, timeout=2) as r:
            return json.loads(r.read())

    def has_video(self, path: str) -> bool:
        """Whether a path is being published with a video track."""
        try:
            p = self._get(f"/v3/paths/get/{path}")
        except Exception:
            return False
        return bool(p.get("ready")) and any(_is_video(t) for t in p.get("tracks2") or [])

    def source_stats(self) -> dict[str, dict]:
        """Who is publishing to each in/<id> path, how, and how well."""
        try:
            paths = self._get("/v3/paths/list?itemsPerPage=1000")["items"]
        except Exception:
            return {}
        conns: dict[str, dict] = {}
        for kind in ("srtconns", "rtmpconns", "webrtcsessions"):
            try:
                for c in self._get(f"/v3/{kind}/list?itemsPerPage=1000")["items"]:
                    if c.get("state") == "publish":
                        conns[c["path"]] = {**c, "_kind": kind}
            except Exception:
                pass
        out: dict[str, dict] = {}
        for p in paths:
            name = p["name"]
            if not name.startswith(SOURCE_PREFIX) or not p.get("ready"):
                continue
            src = p.get("source") or {}
            stats: dict = {"protocol": {"srtConn": "SRT", "rtmpConn": "RTMP", "webRTCSession": "WHIP"}.get(
                src.get("type"), src.get("type"))}
            for track in p.get("tracks2") or []:
                props = track.get("codecProps") or {}
                if _is_video(track):
                    stats.update(video_codec=track.get("codec"), width=props.get("width"), height=props.get("height"))
                else:
                    stats["audio_codec"] = track.get("codec")
            c = conns.get(name)
            if c:
                stats["remote"] = c.get("remoteAddr")
                if c["_kind"] == "srtconns":
                    received = c.get("packetsReceived") or 0
                    lost = c.get("packetsReceivedLoss") or 0
                    stats.update(kbps=round((c.get("mbpsReceiveRate") or 0) * 1000), rtt_ms=round(c.get("msRTT") or 0, 1),
                                 loss_pct=round(100 * lost / received, 2) if received else 0.0)
            out[name[len(SOURCE_PREFIX):]] = stats
        return out
