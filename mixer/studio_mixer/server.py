"""The mixer's HTTP API: pairing, the control WebSocket, graphics upload, WHIP/WHEP and MediaMTX auth.

Everything a studio page needs goes through this one port, so a mixer can
be reached through a single tunnel or port forward:

    GET  /helper, /api/info        who am I (no secrets; the page polls this)
    POST /api/pair                 pairing code -> long-lived token
    GET  /pair                     one-click pairing for a page on this same computer
    GET  /api/control (WebSocket)  workspace + commands in, status + meters out
    PUT  /api/gfx/<key>            a PNG the page drew (scene graphics, keys)
    POST /api/whip/<source id>     a source publishes (OBS, Larix, the page's cameras)
    POST /api/whep/<multiview|program>   the page or a receiver plays a mixer stream
    PATCH/DELETE /api/session/<id> trickle ICE / hang up, for both of the above
    POST /internal/mtx-auth        MediaMTX asks whether a connection is allowed

Control calls carry `Authorization: Bearer <token>` (WebSocket: ?token=).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import sys
import time
import uuid
from collections import OrderedDict
from pathlib import Path

from aiohttp import ClientSession, WSMsgType, web

from . import __version__
from .config import Settings, Store, lan_addresses
from .host import Engine
from .media import MV_BIG, MV_COLS, MV_HEIGHT, MV_TILE, MV_TILES, MV_WIDTH, Format
from .mtx import MediaMTX, source_path
from .outputs import Outputs, find_ffmpeg
from .program import Program
from .tunnel import Tunnel

log = logging.getLogger(__name__)

GFX_LIMIT = 400
SECRET_KEYS = ("key",)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _tunneled(request: web.Request) -> bool:
    """Came in through the https tunnel (cloudflared connects from this computer)."""
    return any(h in request.headers for h in ("Cf-Connecting-Ip", "Cf-Ray", "X-Forwarded-For"))


def _loopback(request: web.Request) -> bool:
    """A request from this computer itself. Tunnel traffic also arrives from 127.0.0.1,
    so it is told apart by its headers and its Host, which is the public address."""
    if (request.remote or "") not in ("127.0.0.1", "::1") or _tunneled(request):
        return False
    host = (request.host or "").rsplit(":", 1)[0].strip("[]").lower()
    return host in ("localhost", "127.0.0.1", "::1")


def _client_ip(request: web.Request) -> str:
    # Behind the tunnel every request comes from 127.0.0.1; Cloudflare says who it really is.
    if _tunneled(request) and (request.remote or "") in ("127.0.0.1", "::1"):
        return request.headers.get("Cf-Connecting-Ip") or "tunnel"
    return request.remote or "?"


class Mixer:
    def __init__(self, settings: Settings, store: Store) -> None:
        self.settings = settings
        self.store = store
        self.secret = store.data["engine_secret"]
        self.mtx = MediaMTX(settings, self.secret)
        self.ffmpeg = find_ffmpeg(settings.ffmpeg_bin)
        p = settings.ports
        self.rtsp = f"rtsp://engine:{self.secret}@127.0.0.1:{p.rtsp}"
        self.outputs = Outputs(f"{self.rtsp}/program", self.ffmpeg, self._outputs_changed,
                               has_video=lambda: self.mtx.has_video("program"))
        self.gfx: OrderedDict[str, bytes] = OrderedDict()
        self.ws = dict(store.data.get("workspace") or {})
        self.clients: set[web.WebSocketResponse] = set()
        self.status: dict = {}
        self.source_stats: dict = {}
        self.sessions: dict[str, tuple[str, dict]] = {}  # our id -> (MediaMTX URL, headers)
        self.pair_attempts: dict[str, list[float]] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.http: ClientSession | None = None
        self.started_at = time.time()
        self._last_status = 0.0
        self._status_pending = False
        self.engine = Engine(self._make_program, settings.encoder, on_rebuilt=self._apply_all)
        # Tell connected studios when the https address appears or changes.
        self.tunnel = Tunnel(settings.cloudflared_bin if settings.tunnel else None, settings.ports.http,
                             lambda: self._threadsafe(lambda: self._broadcast({"t": "info", **self.info()})))

    # ============================================================ engine

    @property
    def fmt(self) -> Format:
        return Format.from_dict(self.ws.get("format"))

    def _make_program(self, fmt: Format, encoder) -> Program:
        p = self.settings.ports
        return Program(
            fmt, encoder, f"srt://127.0.0.1:{p.srt}",
            lambda path: f"publish:{path}:engine:{self.secret}",
            lambda sid: f"{self.rtsp}/{source_path(sid)}",
            self.gfx.get,
            lambda snap: self._threadsafe(self._on_status, snap),
            lambda m: self._threadsafe(self._broadcast, {"t": "meters", **m}),
            kbps=int(self.ws.get("kbps") or 0) or None,
        )

    def _threadsafe(self, fn, *args) -> None:
        if self.loop is not None:
            self.loop.call_soon_threadsafe(fn, *args)

    def start_engine(self) -> None:
        self.engine.start(self.fmt)
        self._apply_all()

    def _apply_all(self, program: Program | None = None) -> None:
        state = {k: self.ws[k] for k in ("sources", "scenes", "overlays", "transition", "audio", "swapOnTake") if k in self.ws}
        shots = self.ws.get("shots") or {}

        def go(p: Program) -> None:
            p.apply(state)
            if shots.get("programme") and p.programme is None:
                p.programme = shots["programme"]
                p._replace_pgm(p.programme)
                p._apply_audio()
            if shots.get("preview") and p.preview is None:
                p.set_preview(shots["preview"])

        go(program) if program is not None else self.engine.call(go)
        self.outputs.sync(self.ws.get("outputs") or [])

    def _save(self) -> None:
        keep = {k: v for k, v in self.ws.items() if k != "outputs"}
        keep["outputs"] = [{k: v for k, v in o.items() if k not in SECRET_KEYS} for o in self.ws.get("outputs") or []]
        self.store.data["workspace"] = keep
        self.store.save()

    # ============================================================ status

    def _on_status(self, snap: dict) -> None:
        self.status = snap
        shots = {"preview": snap.get("preview"), "programme": snap.get("programme")}
        if (self.ws.get("shots") or {}) != shots:
            self.ws["shots"] = shots
        self._queue_status()

    def _outputs_changed(self) -> None:
        self._threadsafe(self._queue_status)

    def _queue_status(self) -> None:
        # At most 8 status messages a second, however busy the engine is.
        if self._status_pending:
            return
        wait = max(0.0, 0.125 - (time.monotonic() - self._last_status))
        self._status_pending = True
        self.loop.call_later(wait, self._send_status)

    def _send_status(self) -> None:
        self._status_pending = False
        self._last_status = time.monotonic()
        self._broadcast(self.status_message())

    def status_message(self) -> dict:
        snap = dict(self.status)
        sources = snap.get("sources") or {}
        for sid, st in self.source_stats.items():
            if sid in sources:
                sources[sid] = {**sources[sid], "ingest": st}
        return {"t": "status", **snap, "outputs": self.outputs.snapshot(), "engineError": self.engine.error,
                "mediamtx": {"running": self.mtx.running, "error": None if self.mtx.running else self.mtx.last_error},
                "clients": len(self.clients)}

    def _broadcast(self, msg: dict) -> None:
        if not self.clients:
            return
        data = json.dumps(msg, separators=(",", ":"))
        for ws in list(self.clients):
            if not ws.closed:
                asyncio.ensure_future(ws.send_str(data))

    async def poll_sources(self) -> None:
        known: set[str] = set()
        while True:
            self.source_stats = await asyncio.to_thread(self.mtx.source_stats)
            fresh = set(self.source_stats) - known
            known = set(self.source_stats)
            for sid in fresh:  # a publisher just arrived: connect without waiting for the retry timer
                self.engine.call(lambda p, sid=sid: p.kick_source(sid))
            await asyncio.sleep(1.0)

    # ============================================================ commands

    def handle(self, msg: dict) -> None:
        t = msg.get("t")
        e = self.engine
        if t in ("hello", "state"):
            self._apply_state(msg.get("ws") or {}, adopt_shots=(t == "hello"))
        elif t == "preview":
            e.call(lambda p: p.set_preview(msg.get("shot")))
        elif t == "cut":
            e.call(lambda p: p.cut())
        elif t == "auto":
            e.call(lambda p: p.auto())
        elif t == "tbar":
            e.call(lambda p: p.tbar(float(msg.get("pos", 0))))
        elif t == "ftb":
            e.call(lambda p: p.toggle_ftb())
        elif t == "key":
            e.call(lambda p: p.set_key(str(msg.get("id")), bool(msg.get("on")), int(msg.get("dur", 500))))
        elif t == "output":
            if msg.get("action") == "start":
                self.outputs.start(str(msg.get("id")))
            else:
                self.outputs.stop(str(msg.get("id")))

    def _apply_state(self, part: dict, adopt_shots: bool) -> None:
        fmt_before, kbps_before = self.fmt, self.ws.get("kbps")
        for k in ("format", "kbps", "sources", "scenes", "overlays", "transition", "audio", "swapOnTake", "outputs"):
            if k in part:
                self.ws[k] = part[k]
        if adopt_shots and part.get("shots") and not self.status.get("programme"):
            self.ws["shots"] = part["shots"]  # a fresh mixer takes the page's shots; a running show keeps its own
        self._save()
        if self.fmt != fmt_before or self.ws.get("kbps") != kbps_before:
            self.engine.restart(self.fmt, self._apply_all)
            return
        state = {k: part[k] for k in ("sources", "scenes", "overlays", "transition", "audio", "swapOnTake") if k in part}
        if state:
            self.engine.call(lambda p: p.apply(state))
        if adopt_shots:
            self._apply_all()
        if "outputs" in part:
            self.outputs.sync(part["outputs"] or [])

    def put_gfx(self, key: str, data: bytes) -> None:
        self.gfx[key] = data
        self.gfx.move_to_end(key)
        while len(self.gfx) > GFX_LIMIT:
            self.gfx.popitem(last=False)
        self.engine.call(lambda p: p.on_gfx(key, data))

    # ============================================================ auth

    def client_for(self, token: str | None) -> dict | None:
        if not token:
            return None
        h = _hash(token)
        return next((c for c in self.store.data["clients"] if hmac.compare_digest(c["hash"], h)), None)

    def source_token_ok(self, sid: str, token: str | None) -> bool:
        if not token:
            return False
        for s in self.ws.get("sources") or []:
            if s.get("id") == sid and s.get("token") and hmac.compare_digest(str(s["token"]), token):
                return True
        return False

    def new_client(self, name: str) -> str:
        token = secrets.token_urlsafe(32)
        self.store.data["clients"].append({"id": uuid.uuid4().hex[:12], "name": name[:80] or "Studio",
                                           "hash": _hash(token), "created": time.time(), "last_seen": time.time()})
        self.store.rotate_code()
        return token

    def info(self) -> dict:
        port = self.settings.ports.http
        return {
            "app": "studio-mixer", "version": __version__, "name": self.store.data["name"],
            "platform": sys.platform, "startedAt": self.started_at, "port": port,
            "lan": [f"http://{ip}:{port}" for ip in lan_addresses()],
            "public": self.tunnel.url,
            "tunnel": {"state": self.tunnel.state, "error": self.tunnel.error},
            "features": ["mixer", "srt", "rtmp", "whip-in", "outputs"],
            "encoder": self.engine.encoder.name if self.engine.encoder else None,
            "ffmpeg": bool(self.ffmpeg), "paired": len(self.store.data["clients"]),
            "ingest": {"srtPort": self.settings.ports.srt, "rtmpPort": self.settings.ports.rtmp},
            "multiview": {"width": MV_WIDTH, "height": MV_HEIGHT, "big": MV_BIG, "tile": MV_TILE,
                          "cols": MV_COLS, "tiles": MV_TILES},
        }


# ================================================================ HTTP

def _bearer(request: web.Request) -> str | None:
    h = request.headers.get("Authorization", "")
    return h[7:].strip() if h.lower().startswith("bearer ") else None


@web.middleware
async def cors(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as exc:
            resp = exc
    if request.path.startswith(("/api/", "/helper")):
        resp.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*")
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, If-Match"
        resp.headers["Access-Control-Expose-Headers"] = "Location, Link, ETag"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        resp.headers["Vary"] = "Origin"
    return resp


def build_app(m: Mixer) -> web.Application:
    app = web.Application(middlewares=[cors], client_max_size=16 * 1024 * 1024)
    r = app.router

    def require_client(request: web.Request) -> dict:
        c = m.client_for(_bearer(request) or request.query.get("token"))
        if c is None:
            raise web.HTTPUnauthorized(text="This studio is not paired with the mixer.")
        return c

    async def helper(_req):
        return web.json_response(m.info())

    async def pair(request: web.Request):
        ip = _client_ip(request)
        now = time.time()
        recent = [t for t in m.pair_attempts.get(ip, []) if now - t < 60]
        # The tunnel makes the mixer reachable from anywhere: also cap guesses from everyone together.
        everyone = [t for ts in m.pair_attempts.values() for t in ts if now - t < 60]
        if len(recent) >= 5 or len(everyone) >= 30:
            raise web.HTTPTooManyRequests(text="Too many attempts. Wait a minute and try again.")
        m.pair_attempts = {k: [t for t in v if now - t < 60] for k, v in m.pair_attempts.items() if any(now - t < 60 for t in v)}
        m.pair_attempts[ip] = recent + [now]
        body = await request.json()
        code = str(body.get("code", "")).strip().replace(" ", "")
        if not hmac.compare_digest(code, m.store.data["pair_code"]):
            raise web.HTTPForbidden(text="Wrong pairing code. Check the code shown on the mixer computer.")
        token = m.new_client(str(body.get("name") or request.headers.get("Origin") or "Studio"))
        return web.json_response({"token": token, **m.info()})

    async def pair_page(request: web.Request):
        if not _loopback(request):
            raise web.HTTPForbidden(text="Open this page on the mixer computer.")
        origin = request.query.get("origin", "")
        if not (origin.startswith("https://") or origin.startswith("http://localhost") or origin.startswith("http://127.0.0.1")):
            raise web.HTTPBadRequest(text="Missing or unsupported origin.")
        return web.Response(text=PAIR_HTML.replace("{{ORIGIN}}", json.dumps(origin)).replace(
            "{{ORIGIN_TEXT}}", origin.replace("<", "&lt;")).replace("{{NAME}}", m.store.data["name"].replace("<", "&lt;")),
            content_type="text/html")

    async def pair_local(request: web.Request):
        # Only the page above, on this computer, after a click: the Origin is the mixer itself.
        if not _loopback(request) or request.headers.get("Origin") not in (
                f"http://localhost:{m.settings.ports.http}", f"http://127.0.0.1:{m.settings.ports.http}"):
            raise web.HTTPForbidden()
        body = await request.json()
        token = m.new_client(str(body.get("origin") or "Studio on this computer"))
        return web.json_response({"token": token})

    async def home(request: web.Request):
        local = _loopback(request)
        code = m.store.data["pair_code"] if local else None
        return web.Response(text=HOME_HTML.replace("{{NAME}}", m.store.data["name"].replace("<", "&lt;"))
                            .replace("{{CODE}}", f"{code[:3]} {code[3:]}" if code else "shown on the mixer computer")
                            .replace("{{ADDR}}", " · ".join(m.info()["lan"])).replace("{{VERSION}}", __version__)
                            .replace("{{PUBLIC}}", m.tunnel.url or ("starting…" if m.tunnel.state == "starting" else "none (" + (m.tunnel.error or "off") + ")")),
                            content_type="text/html")

    async def control(request: web.Request):
        c = require_client(request)
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=8 * 1024 * 1024)
        await ws.prepare(request)
        m.clients.add(ws)
        m.store.touch(c["id"])
        await ws.send_str(json.dumps({"t": "hello", **m.info(), "workspace": {k: v for k, v in m.ws.items() if k != "outputs"}}))
        await ws.send_str(json.dumps(m.status_message()))
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        m.handle(json.loads(msg.data))
                    except Exception:
                        log.exception("bad control message")
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            m.clients.discard(ws)
        return ws

    async def put_gfx(request: web.Request):
        require_client(request)
        key = request.match_info["key"]
        data = await request.read()
        if not data.startswith(b"\x89PNG"):
            raise web.HTTPBadRequest(text="PNG expected")
        m.put_gfx(key, data)
        return web.Response(status=204)

    async def status(request: web.Request):
        require_client(request)
        return web.json_response(m.status_message())

    # ---------------------------------------------------- WHIP / WHEP proxy

    async def _forward(request: web.Request, url: str, headers: dict) -> web.Response:
        body = await request.read()
        hdrs = {**headers, "Content-Type": request.headers.get("Content-Type", "application/sdp")}
        async with m.http.request(request.method, url, data=body, headers=hdrs) as resp:
            text = await resp.read()
            out = web.Response(status=resp.status, body=text,
                               content_type=resp.headers.get("Content-Type", "application/sdp").split(";")[0])
            if "Link" in resp.headers:
                out.headers["Link"] = resp.headers["Link"]
            if "ETag" in resp.headers:
                out.headers["ETag"] = resp.headers["ETag"]
            loc = resp.headers.get("Location")
            if loc and resp.status in (200, 201):
                sid = uuid.uuid4().hex
                full = loc if loc.startswith("http") else f"http://127.0.0.1:{m.settings.ports.webrtc}{loc}"
                m.sessions[sid] = (full, headers)
                out.headers["Location"] = f"/api/session/{sid}"
            return out

    async def whip(request: web.Request):
        sid = request.match_info["sid"]
        token = _bearer(request) or request.query.get("token")
        if m.client_for(token):  # the page publishing one of its cameras: use the source's own token
            src = next((s for s in m.ws.get("sources") or [] if s.get("id") == sid), None)
            token = (src or {}).get("token")
        if not m.source_token_ok(sid, token):
            raise web.HTTPUnauthorized(text="Unknown source or wrong token.")
        url = f"http://127.0.0.1:{m.settings.ports.webrtc}/{source_path(sid)}/whip"
        return await _forward(request, url, {"Authorization": f"Bearer {token}"})

    async def whep(request: web.Request):
        path = request.match_info["path"]
        if path not in ("multiview", "program"):
            raise web.HTTPNotFound()
        require_client(request)
        import base64
        basic = base64.b64encode(f"engine:{m.secret}".encode()).decode()
        url = f"http://127.0.0.1:{m.settings.ports.webrtc}/{path}/whep"
        return await _forward(request, url, {"Authorization": f"Basic {basic}"})

    async def session(request: web.Request):
        s = m.sessions.get(request.match_info["id"])
        if s is None:
            raise web.HTTPNotFound()
        url, headers = s
        if request.method == "DELETE":
            m.sessions.pop(request.match_info["id"], None)
        body = await request.read()
        hdrs = {**headers, "Content-Type": request.headers.get("Content-Type", "application/trickle-ice-sdpfrag")}
        if "If-Match" in request.headers:
            hdrs["If-Match"] = request.headers["If-Match"]
        async with m.http.request(request.method, url, data=body, headers=hdrs) as resp:
            return web.Response(status=resp.status, body=await resp.read())

    # ---------------------------------------------------- MediaMTX auth hook

    async def mtx_auth(request: web.Request):
        if not _loopback(request):
            raise web.HTTPForbidden()
        b = await request.json()
        user, pw, token = b.get("user") or "", b.get("password") or "", b.get("token") or ""
        action, path, ip = b.get("action"), b.get("path") or "", b.get("ip") or ""
        if user == "engine" and hmac.compare_digest(pw, m.secret):
            if ip in ("127.0.0.1", "::1") or action == "read":
                return web.Response(status=200)
        if action == "publish" and path.startswith("in/"):
            if m.source_token_ok(path[3:], token or pw):
                return web.Response(status=200)
        return web.Response(status=401)

    r.add_get("/", home)
    r.add_get("/helper", helper)
    r.add_get("/api/info", helper)
    r.add_post("/api/pair", pair)
    r.add_get("/pair", pair_page)
    r.add_post("/pair/local", pair_local)
    r.add_get("/api/control", control)
    r.add_get("/api/status", status)
    r.add_put("/api/gfx/{key}", put_gfx)
    r.add_post("/api/whip/{sid}", whip)
    r.add_post("/api/whep/{path}", whep)
    r.add_route("PATCH", "/api/session/{id}", session)
    r.add_route("DELETE", "/api/session/{id}", session)
    r.add_post("/internal/mtx-auth", mtx_auth)
    return app


STYLE = """<style>body{font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e7e9ee;margin:0;display:grid;
place-items:center;min-height:100vh}main{max-width:460px;padding:24px}h1{font-size:20px;margin:0 0 4px}.code{font:700 40px ui-monospace,
monospace;letter-spacing:4px;margin:12px 0}.muted{color:#9aa3b2}button{font:600 15px system-ui;padding:10px 18px;border:0;
border-radius:8px;background:#e11d48;color:#fff;cursor:pointer}</style>"""

HOME_HTML = f"""<!doctype html><meta charset=utf-8><title>Studio Mixer</title>{STYLE}<main>
<h1>Studio Mixer · {{{{NAME}}}}</h1><p class=muted>Version {{{{VERSION}}}} is running.</p>
<p>To connect a studio, open the studio page, go to Settings, Mixer, and enter this pairing code:</p>
<div class=code>{{{{CODE}}}}</div><p>https address (use this in the studio page): <b>{{{{PUBLIC}}}}</b></p>
<p class=muted>Mixer address on your network: {{{{ADDR}}}}</p></main>"""

PAIR_HTML = f"""<!doctype html><meta charset=utf-8><title>Connect to Studio Mixer</title>{STYLE}<main>
<h1>Connect this studio to the mixer?</h1><p class=muted>{{{{ORIGIN_TEXT}}}} wants to control the mixer
<b>{{{{NAME}}}}</b> on this computer.</p><button id=b>Connect</button> <span id=s class=muted></span>
<script>const origin={{{{ORIGIN}}}};document.getElementById('b').onclick=async()=>{{
const r=await fetch('/pair/local',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{origin}})}});
if(!r.ok){{document.getElementById('s').textContent='Failed: '+r.status;return}}
const {{token}}=await r.json();(window.opener||parent).postMessage({{type:'studio-mixer-token',token,url:location.origin}},origin);
document.getElementById('s').textContent='Connected. You can close this window.';setTimeout(()=>window.close(),800)}};</script></main>"""


async def serve(m: Mixer) -> None:
    m.loop = asyncio.get_running_loop()
    m.http = ClientSession()
    runner = web.AppRunner(build_app(m), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, m.settings.bind, m.settings.ports.http).start()
    # MediaMTX asks this API to authorise connections, so it starts after the API is listening.
    m.mtx.start()
    m.tunnel.start()
    await asyncio.sleep(1.0)
    await asyncio.to_thread(m.start_engine)
    asyncio.ensure_future(m.poll_sources())
    port = m.settings.ports.http
    log.info("Studio Mixer ready on http://localhost:%d (network: %s). Pairing code: %s", port,
             ", ".join(m.info()["lan"]), m.store.data["pair_code"])
    stop = asyncio.Event()
    try:
        import signal
        for sig in (signal.SIGINT, signal.SIGTERM):
            m.loop.add_signal_handler(sig, stop.set)
    except (NotImplementedError, RuntimeError):
        pass
    try:
        await stop.wait()
    finally:
        m.outputs.stop_all()
        m.tunnel.stop()
        await asyncio.to_thread(m.engine.stop)
        m.mtx.stop()
        await m.http.close()
        await runner.cleanup()
