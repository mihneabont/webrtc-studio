#!/usr/bin/env node
// OPTIONAL signaling relay for WebRTC Studio. Zero dependencies (Node 18+).
//
// The studio works without this. Host it somewhere reachable (any small server)
// if you want any of:
//   1. Signaling relay   - reusable contributor/receiver links with automatic
//                          reconnection instead of copy-paste codes.
//   2. CORS forwarder    - for WHIP/WHEP endpoints that don't allow browser
//                          requests. Forwards the SDP HTTP exchange only.
//   3. WHIP test sink    - a WHIP endpoint that hands the stream to a browser
//                          receiver page, to test WHIP output end to end.
//   4. Static hosting    - --static <dir> serves the app itself (local use).
// It never receives, decodes or forwards audio/video: media flows directly
// between browsers (or via your TURN server). SRT, RTMP and OBS input and RTMP
// output are the Studio Mixer's job (mixer/).
//
// Usage: node server.mjs [--port 8787] [--static ..]
// Env:   FORWARD_ALLOW=host1,host2   hosts the CORS forwarder may call
//        (default: g.webrtc.live-video.net). Use '*' to allow any https host.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(arg('--port', process.env.PORT || 8787));
const STATIC = arg('--static', null);
const FORWARD_ALLOW = (process.env.FORWARD_ALLOW || 'g.webrtc.live-video.net').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 256 * 1024;

const rooms = new Map(); // room -> Map(peer -> {res, queue})
const pending = new Map(); // gen -> resolve(message): answers awaited by HTTP requests
const sessions = new Map(); // WHIP test session id -> {room, peer}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
  res.setHeader('Access-Control-Expose-Headers', 'Location, ETag, Link, Accept-Patch');
  // Lets a studio page hosted on a public site reach a relay on localhost
  // (Chrome's Private Network Access preflight).
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function peerSlot(room, peer) {
  if (!rooms.has(room)) rooms.set(room, new Map());
  const r = rooms.get(room);
  if (!r.has(peer)) r.set(peer, { res: null, queue: [] });
  return r.get(peer);
}

function deliver(room, peer, msg) {
  const slot = peerSlot(room, peer);
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  if (slot.res) slot.res.write(data);
  else {
    slot.queue.push({ data, t: Date.now() });
    if (slot.queue.length > 20) slot.queue.shift();
  }
}

function waitFor(gen, ms, send) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(gen); resolve(null); }, ms);
    pending.set(gen, (msg) => { clearTimeout(timer); pending.delete(gen); resolve(msg); });
    send();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const valid = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
async function handle(req, res) {
  cors(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (req.method === 'OPTIONS') { res.writeHead(204, parts[0] === 'whip' ? { 'Accept-Post': 'application/sdp' } : {}).end(); return; }

  // 1. Relay: GET = subscribe (Server-Sent Events), POST = send to a peer.
  if (parts[0] === 'r' && parts.length === 3 && valid(parts[1]) && valid(parts[2])) {
    const [, room, peer] = parts;
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      const slot = peerSlot(room, peer);
      slot.res?.end();
      slot.res = res;
      const now = Date.now();
      for (const q of slot.queue.splice(0)) if (now - q.t < 60000) res.write(q.data);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); if (slot.res === res) slot.res = null; });
      return;
    }
    if (req.method === 'POST') {
      let msg;
      try { msg = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end('bad json'); return; }
      if (!msg || typeof msg !== 'object' || !valid(msg.from)) { res.writeHead(400).end('missing from'); return; }
      // Replies to WHIP requests waiting on this server are consumed here.
      if (typeof msg.gen === 'string' && pending.has(msg.gen)) {
        pending.get(msg.gen)(msg);
      } else {
        deliver(room, peer, msg);
      }
      res.writeHead(202).end();
      return;
    }
  }

  // 2. CORS forwarder for WHIP/WHEP signaling.
  if (parts[0] === 'forward') {
    const target = url.searchParams.get('target');
    let t;
    try { t = new URL(target); } catch { res.writeHead(400).end('bad target'); return; }
    const allowed = t.protocol === 'https:' && (FORWARD_ALLOW.includes('*') || FORWARD_ALLOW.some((h) => t.hostname === h || t.hostname.endsWith(`.${h}`)));
    if (!allowed) { res.writeHead(403).end(`target host not allowed; set FORWARD_ALLOW to include ${t.hostname}`); return; }
    const headers = {};
    for (const h of ['content-type', 'authorization', 'if-match']) if (req.headers[h]) headers[h] = req.headers[h];
    try {
      const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
      const r = await fetch(t, { method: req.method, headers, body, redirect: 'follow' });
      const text = await r.text();
      const out = { 'Content-Type': r.headers.get('content-type') || 'text/plain' };
      const loc = r.headers.get('location');
      if (loc) {
        const abs = new URL(loc, r.url).toString();
        out.Location = `${url.protocol}//${req.headers.host}/forward?target=${encodeURIComponent(abs)}`;
      }
      for (const h of ['etag', 'link']) if (r.headers.get(h)) out[h] = r.headers.get(h);
      res.writeHead(r.status, out).end(text);
    } catch (e) {
      res.writeHead(502).end(`forward failed: ${e.message}`);
    }
    return;
  }

  // 3. WHIP test sink: POST an SDP offer to /whip/<room>/<peer>; the browser
  //    receiver opened with receive.html#sig=…&room=<room>&out=<peer> answers it.
  if (parts[0] === 'whip' && parts.length === 3 && valid(parts[1]) && valid(parts[2]) && req.method === 'POST') {
    const [, room, out] = parts;
    const sdp = await readBody(req);
    if (!sdp.startsWith('v=0')) { res.writeHead(400).end('expected application/sdp'); return; }
    const id = `whip-${crypto.randomUUID()}`;
    const reply = await waitFor(id, 15000, () => deliver(room, `out-${out}`, { from: 'studio', type: 'offer', sdp, gen: id, name: 'WHIP test', ice: {} }));
    if (!reply) { res.writeHead(503).end('no receiver answered (is receive.html open?)'); return; }
    sessions.set(id, { room, peer: `out-${out}` });
    res.writeHead(201, { 'Content-Type': 'application/sdp', Location: `${url.protocol}//${req.headers.host}/whip-session/${id}` }).end(reply.sdp);
    return;
  }
  if (parts[0] === 'whip-session' && parts.length === 2 && req.method === 'DELETE') {
    const s = sessions.get(parts[1]);
    if (!s) { res.writeHead(404).end(); return; }
    deliver(s.room, s.peer, { from: 'studio', type: 'bye' });
    sessions.delete(parts[1]);
    res.writeHead(200, { 'Content-Length': 0 }).end();
    return;
  }

  // 4. Optional static hosting of the app.
  if (STATIC && req.method === 'GET') {
    const root = path.resolve(STATIC);
    let file = path.resolve(root, `.${url.pathname}`);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown' };
    res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    fs.createReadStream(file).pipe(res);
    return;
  }

  res.writeHead(404).end('not found');
}

http.createServer((req, res) => handle(req, res).catch((e) => { try { res.writeHead(500).end(e.message); } catch { /* ignore */ } }))
  .listen(PORT, () => {
    console.log(`WebRTC Studio relay on http://localhost:${PORT}`);
    console.log(`  relay:     /r/<room>/<peer>`);
    console.log(`  forwarder: /forward?target=<url>   (allowed hosts: ${FORWARD_ALLOW.join(', ')})`);
    console.log(`  WHIP sink: /whip/<room>/<output>`);
    if (STATIC) console.log(`  static:    ${path.resolve(STATIC)}`);
  });
