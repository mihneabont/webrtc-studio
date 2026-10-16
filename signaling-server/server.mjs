#!/usr/bin/env node
// OPTIONAL helper for WebRTC Studio. Zero dependencies (Node 18+).
//
// The studio works without this. Run it only if you want any of:
//   1. Signaling relay   - reusable contributor/receiver links with automatic
//                          reconnection instead of copy-paste codes.
//   2. CORS forwarder    - for WHIP/WHEP endpoints that don't allow browser
//                          requests. Forwards the SDP HTTP exchange only.
//   3. WHIP ingest       - lets OBS (or any WHIP encoder) send into the studio:
//                          POST /whip-in/<room>/<source> is handed to the studio
//                          page, which answers; media goes encoder -> browser.
//   4. WHIP test sink    - a WHIP endpoint that hands the stream to a browser
//                          receiver page, to test WHIP output end to end.
//   5. Static hosting    - --static <dir> serves the app itself (local use).
//
// It never receives, decodes or forwards audio/video: media always flows
// directly between browsers (or via your TURN server).
//
// Usage: node server.mjs [--port 8787] [--static ..]
// Env:   FORWARD_ALLOW=host1,host2   hosts the CORS forwarder may call
//        (default: g.webrtc.live-video.net). Use '*' to allow any https host.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import dns from 'node:dns/promises';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(arg('--port', process.env.PORT || 8787));
const STATIC = arg('--static', null);
const FORWARD_ALLOW = (process.env.FORWARD_ALLOW || 'g.webrtc.live-video.net').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 256 * 1024;

const rooms = new Map(); // room -> Map(peer -> {res, queue})
const pending = new Map(); // gen -> resolve(message): answers awaited by HTTP requests
const sessions = new Map(); // WHIP session id -> {room, peer|slot, kind}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
  res.setHeader('Access-Control-Expose-Headers', 'Location, ETag, Link, Accept-Patch');
  // Lets a studio page hosted on a public site reach a helper on localhost
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
const log = (...a) => console.log(new Date().toISOString(), ...a);
const candSummary = (sdp) => {
  const c = [...sdp.matchAll(/^a=candidate:\S+ \d+ (\S+) \d+ (\S+) \d+ typ (\S+)/gim)].map((m) => `${m[3]}/${m[1].toLowerCase()}/${m[2]}`);
  return c.length ? c.join(', ') : 'no candidates';
};

// Chrome hides the studio's own LAN address behind a random <uuid>.local name
// unless the page has camera permission. Native encoders (phone apps, OBS on
// another machine) usually can't resolve those, so ICE fails. Replace each
// name with the address it resolves to, or, if it doesn't resolve, with this
// machine's LAN addresses (the helper normally runs next to the studio).
function lanIPv4() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address);
}
// Is this request from an encoder on this same machine (e.g. OBS)?
function isLocalRequest(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '::1' || ip.startsWith('127.') || lanIPv4().includes(ip);
}
// For an encoder on this machine keep exactly one candidate: the first IPv4
// host one. Anything else (srflx, IPv6, other interfaces) only adds ways for
// a local encoder to fail fast.
function onlyLocalHost(sdp) {
  let kept = false;
  return sdp.split(/\r?\n/).filter((l) => {
    if (!l.startsWith('a=candidate:')) return true;
    if (!kept && /^a=candidate:\S+ 1 udp \d+ \d+\.\d+\.\d+\.\d+ \d+ typ host/i.test(l)) return (kept = true);
    return false;
  }).join('\r\n');
}
async function unhideMdns(sdp) {
  const names = [...new Set([...sdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+\.local) /gim)].map((m) => m[1]))];
  const lineRe = (name) => new RegExp(`^a=candidate:(\\S+)( \\d+ \\S+ \\d+ )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( [^\\r\\n]*)(\\r?\\n)?`, 'gim');
  const subst = (s, name, ips) => s.replace(lineRe(name), (_, f, mid, rest, nl = '') => ips.map((ip, i) => `a=candidate:${f}${i || ''}${mid}${ip}${rest}${nl || '\r\n'}`).join(''));
  const unresolved = [];
  for (const name of names) {
    let ips = [];
    try {
      const found = await Promise.race([dns.lookup(name, { all: true, family: 4 }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
      ips = found.map((a) => a.address);
    } catch { /* not resolvable here, e.g. a hidden IPv6 socket */ }
    if (ips.length) sdp = subst(sdp, name, ips); else unresolved.push(name);
  }
  // Guessing addresses puts candidates on ports nobody listens on; an encoder
  // on this same machine gets instant "port unreachable" errors for those,
  // which makes OBS (libjuice) fail ICE at once. So once a real IPv4 host
  // address is known, drop unresolvable names; guess only if there is none.
  const hasRealHost = /^a=candidate:\S+ \d+ udp \d+ \d+\.\d+\.\d+\.\d+ \d+ typ host/im.test(sdp);
  const guess = hasRealHost ? [] : lanIPv4();
  for (const name of unresolved) sdp = subst(sdp, name, guess);
  return sdp;
}

async function handle(req, res) {
  cors(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (req.method === 'OPTIONS') { res.writeHead(204, parts[0] === 'whip-in' || parts[0] === 'whip-session' ? { 'Accept-Post': 'application/sdp', 'Accept-Patch': 'application/trickle-ice-sdpfrag' } : {}).end(); return; }
  if (parts[0] === 'helper' && parts.length === 1) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ app: 'webrtc-studio-helper', features: ['relay', 'forward', 'whip-in', 'whip-test'] }));
    return;
  }

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

  // 3. WHIP ingest into the studio (OBS etc.). The studio page checks the token.
  if (parts[0] === 'whip-in' && parts.length === 3 && valid(parts[1]) && valid(parts[2]) && req.method === 'POST') {
    const [, room, slot] = parts;
    const sdp = await readBody(req);
    log(`WHIP in ${slot} from ${req.socket.remoteAddress} (${req.headers['user-agent'] || '?'}): offer ${candSummary(sdp)}`);
    if (!sdp.startsWith('v=0')) { res.writeHead(400).end('expected an application/sdp offer'); return; }
    const id = `in-${crypto.randomUUID()}`;
    const local = isLocalRequest(req);
    // An ice-lite encoder (e.g. Larix) never starts connectivity checks, so
    // without its own candidates nobody can reach it, and it never trickles
    // them later. Refuse at once so it retries now instead of after ~30 s.
    if (!local && /^a=ice-lite/m.test(sdp) && !/^a=candidate:/m.test(sdp)) {
      log('  -> 503 ice-lite offer without candidates; asking the encoder to retry');
      res.writeHead(503, { 'Retry-After': '1' }).end('The encoder sent no network addresses (ice-lite, no candidates). Retrying usually helps.');
      return;
    }
    const reply = await waitFor(id, 15000, () => deliver(room, 'studio', { from: 'ingest', type: 'whip-offer', slot, sdp, gen: id, local, auth: req.headers.authorization || '' }));
    if (!reply) { log(`  -> 503 studio did not answer`); res.writeHead(503).end('The studio did not answer. Is the studio page open with this helper configured?'); return; }
    if (reply.type !== 'answer') { log(`  -> ${reply.status || 403} ${reply.reason || 'rejected'}`); res.writeHead(reply.status || 403).end(reply.reason || 'rejected'); return; }
    let answer = await unhideMdns(reply.sdp);
    if (local) answer = onlyLocalHost(answer);
    log(`  -> 201 answer ${candSummary(answer)}`);
    if (process.env.WHIP_DEBUG) log(`  OFFER:\n${sdp}\n  ANSWER:\n${answer}`);
    sessions.set(id, { room, slot, kind: 'in' });
    res.writeHead(201, { 'Content-Type': 'application/sdp', ETag: `"${id}"`, 'Accept-Patch': 'application/trickle-ice-sdpfrag', Location: `${url.protocol}//${req.headers.host}/whip-session/${id}` }).end(answer);
    return;
  }

  // 4. WHIP test sink: POST an SDP offer to /whip/<room>/<peer>; the browser
  //    receiver opened with receive.html#sig=…&room=<room>&out=<peer> answers it.
  if (parts[0] === 'whip' && parts.length === 3 && valid(parts[1]) && valid(parts[2]) && req.method === 'POST') {
    const [, room, out] = parts;
    const sdp = await readBody(req);
    if (!sdp.startsWith('v=0')) { res.writeHead(400).end('expected application/sdp'); return; }
    const id = `whip-${crypto.randomUUID()}`;
    const reply = await waitFor(id, 15000, () => deliver(room, `out-${out}`, { from: 'studio', type: 'offer', sdp, gen: id, name: 'WHIP test', ice: {} }));
    if (!reply) { res.writeHead(503).end('no receiver answered (is receive.html open?)'); return; }
    sessions.set(id, { room, peer: `out-${out}`, kind: 'test' });
    res.writeHead(201, { 'Content-Type': 'application/sdp', Location: `${url.protocol}//${req.headers.host}/whip-session/${id}` }).end(reply.sdp);
    return;
  }
  if (parts[0] === 'whip-session' && parts.length === 2 && (req.method === 'DELETE' || req.method === 'PATCH')) {
    const s = sessions.get(parts[1]);
    log(`${req.method} ${parts[1]} from ${req.socket.remoteAddress}${s ? '' : ' (unknown session)'}`);
    if (!s) { res.writeHead(404).end(); return; }
    if (req.method === 'PATCH') {
      // Trickle ICE from an encoder: pass its candidates on to the studio page.
      if (s.kind !== 'in') { res.writeHead(405).end('trickle ICE is not supported; send all candidates in the offer'); return; }
      const frag = await readBody(req);
      log(`  trickle: ${candSummary(frag)}`);
      deliver(s.room, 'studio', { from: 'ingest', type: 'whip-trickle', slot: s.slot, gen: parts[1], frag });
      res.writeHead(204).end();
      return;
    }
    if (s.kind === 'in') deliver(s.room, 'studio', { from: 'ingest', type: 'whip-bye', slot: s.slot, gen: parts[1] });
    else deliver(s.room, s.peer, { from: 'studio', type: 'bye' });
    sessions.delete(parts[1]);
    res.writeHead(200).end();
    return;
  }

  // 5. Optional static hosting of the app.
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
    console.log(`WebRTC Studio helper on http://localhost:${PORT}`);
    console.log(`  relay:     /r/<room>/<peer>`);
    console.log(`  forwarder: /forward?target=<url>   (allowed hosts: ${FORWARD_ALLOW.join(', ')})`);
    console.log(`  WHIP in:   /whip-in/<room>/<source>   (OBS -> studio)`);
    console.log(`  WHIP sink: /whip/<room>/<output>`);
    if (STATIC) console.log(`  static:    ${path.resolve(STATIC)}`);
  });
