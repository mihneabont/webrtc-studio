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
//   6. RTMP output       - the studio page records its programme and posts the
//                          pieces here; ffmpeg pushes them to an RTMP server
//                          (Twitch, YouTube, ...). Needs ffmpeg installed.
//   7. SRT input         - listens for an SRT sender; ffmpeg converts it to
//                          WebRTC and sends it into the studio like OBS (3).
//                          Needs ffmpeg installed.
//
// Apart from the RTMP output (6) and SRT input (7), it never receives, decodes
// or forwards audio/video: media flows directly between browsers (or via your
// TURN server).
//
// Usage: node server.mjs [--port 8787] [--static ..] [--ffmpeg path]
// Env:   FORWARD_ALLOW=host1,host2   hosts the CORS forwarder may call
//        (default: g.webrtc.live-video.net). Use '*' to allow any https host.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(arg('--port', process.env.PORT || 8787));
const STATIC = arg('--static', null);
const FORWARD_ALLOW = (process.env.FORWARD_ALLOW || 'g.webrtc.live-video.net').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 256 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
// Raise when the studio page needs something new from the helper; the page
// (HELPER_VERSION in js/ui/helper-install.js) then offers an update.
const VERSION = 2;

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
// ffmpeg's WHIP muxer lists its retransmission (RTX) stream in a FID group
// but gives it no a=ssrc lines, which Chrome refuses ("Failed to add remote
// stream ssrc"). Add the missing lines, copied from the primary stream.
function fixSsrcGroups(sdp) {
  const lines = sdp.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const g = /^a=ssrc-group:FID (\d+) (\d+)/.exec(lines[i]);
    if (!g || lines.some((l) => l.startsWith(`a=ssrc:${g[2]} `))) continue;
    // Insert after the primary's own a=ssrc lines, which follow the group.
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith(`a=ssrc:${g[1]} `)) out.push(lines[j++]);
    for (const l of lines.slice(i + 1, j)) out.push(l.replace(`a=ssrc:${g[1]} `, `a=ssrc:${g[2]} `));
    i = j - 1;
  }
  return out.join('\r\n');
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

// --- 6. RTMP output -----------------------------------------------------------
// Looked up on every use, so installing ffmpeg works without restarting the helper.
// winget puts ffmpeg on the user's PATH, but a helper started before that (or at
// sign-in from an older environment) may not see it, so its folders are checked too.
function findFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [arg('--ffmpeg', null), process.env.FFMPEG, path.join(path.dirname(fileURLToPath(import.meta.url)), exe)];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const wg = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    candidates.push(path.join(wg, 'Links', exe));
    try {
      for (const pkg of fs.readdirSync(path.join(wg, 'Packages')).filter((d) => /ffmpeg/i.test(d))) {
        const root = path.join(wg, 'Packages', pkg);
        for (const sub of fs.readdirSync(root)) candidates.push(path.join(root, sub, 'bin', exe));
      }
    } catch { /* no winget packages */ }
  }
  return candidates.find((c) => { try { return c && fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

const rtmp = new Map(); // id -> session
const maskUrl = (u) => u.replace(/\/[^/]*$/, '/••••');

function startRtmp({ url, codec, kbps, fps }) {
  const ff = findFfmpeg();
  if (!ff) throw Object.assign(new Error('ffmpeg is not installed on this computer. Run the helper installer again, or install ffmpeg.'), { status: 501 });
  if (!/^rtmps?:\/\/[^\s/]+\/\S+$/i.test(url || '')) throw Object.assign(new Error('Enter an rtmp:// or rtmps:// server URL.'), { status: 400 });
  const id = crypto.randomUUID();
  const gop = Math.max(1, Math.round((Number(fps) || 30) * 2));
  // H.264 from the browser is passed through untouched (cheap). Anything else
  // (browsers without an H.264 recorder) is re-encoded, which costs CPU.
  const video = codec === 'h264' ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', String(gop),
      '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`];
  const argv = ['-hide_banner', '-loglevel', 'error', '-stats', '-fflags', '+genpts', '-f', 'matroska,webm', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?', ...video, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-flvflags', 'no_duration_filesize', '-f', 'flv', url];
  const p = spawn(ff, argv, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const s = { id, p, url: maskUrl(url), state: 'running', stats: null, errors: [], last: Date.now(), bytes: 0, code: null };
  let buf = '';
  p.stderr.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r|\n/); buf = lines.pop();
    for (const l of lines.map((x) => x.trim()).filter(Boolean)) {
      // Progress lines look like "frame= 123 fps= 30 ... size= 1024kB time=00:00:04.10 bitrate=2046.1kbits/s speed=1x";
      // with copied video ffmpeg may leave out frame/fps.
      if (/time=\s*\S+/.test(l) && /bitrate=/.test(l)) {
        const f = (k) => (new RegExp(`${k}=\\s*([^\\s]+)`).exec(l) || [])[1];
        const t = f('time') || '';
        const secs = t.split(':').reduce((a, x) => a * 60 + (Number(x) || 0), 0);
        s.stats = { frames: Number(f('frame')) || 0, fps: f('fps') !== undefined ? Number(f('fps')) : undefined, time: t.replace(/\.\d+$/, ''), secs,
          kbps: parseFloat(f('bitrate')) || 0, speed: parseFloat(f('speed')) || 0 };
      } else { s.errors.push(l.replaceAll(url, s.url).replace(/^\[[^\]]*\]\s*/, "")); if (s.errors.length > 12) s.errors.shift(); }
    }
  });
  p.stdin.on('error', () => { /* ffmpeg exited; reported through state */ });
  p.on('error', (e) => { s.state = 'ended'; s.errors.push(e.message); });
  p.on('exit', (code) => { s.state = 'ended'; s.code = code; log(`RTMP ${id.slice(0, 8)} ended (exit ${code}) ${s.errors.slice(-2).join(' | ')}`); });
  rtmp.set(id, s);
  log(`RTMP ${id.slice(0, 8)} -> ${s.url} (video ${codec === 'h264' ? 'copied' : 're-encoded'})`);
  return s;
}
function stopRtmp(s) {
  if (!s) return;
  rtmp.delete(s.id);
  try { s.p.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => { if (s.p.exitCode === null) s.p.kill(); }, 3000);
}
const rtmpStatus = (s) => ({ id: s.id, state: s.state, stats: s.stats, error: s.state === 'ended' ? (s.errors.slice(-3).join(' ') || `ffmpeg exited (code ${s.code})`) : null, url: s.url });
// The page stops sending when it closes; don't keep ffmpeg around for it.
setInterval(() => { for (const s of rtmp.values()) if (Date.now() - s.last > 20000) { log(`RTMP ${s.id.slice(0, 8)}: no data for 20 s, stopping`); stopRtmp(s); } }, 5000).unref();

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleRtmp(req, res, parts) {
  const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
  if (parts.length === 1 && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: 'bad json' }); return; }
    try { json(201, rtmpStatus(startRtmp(body))); } catch (e) { json(e.status || 500, { error: e.message }); }
    return;
  }
  const s = rtmp.get(parts[1]);
  if (!s) { json(404, { error: 'This RTMP session has ended.' }); return; }
  if (parts.length === 2 && req.method === 'GET') { json(200, rtmpStatus(s)); return; }
  if (parts.length === 2 && req.method === 'DELETE') { stopRtmp(s); json(200, { ok: true }); return; }
  if (parts.length === 3 && parts[2] === 'data' && req.method === 'POST') {
    const data = await readRaw(req, MAX_CHUNK);
    s.last = Date.now();
    if (s.state !== 'running') { json(410, rtmpStatus(s)); return; }
    s.bytes += data.length;
    // Wait until ffmpeg has taken the piece, so a slow upstream slows the page
    // down (and the page can tell) instead of filling memory here.
    if (!s.p.stdin.write(data)) await new Promise((r) => { s.p.stdin.once('drain', r); s.p.once('exit', r); });
    json(200, rtmpStatus(s));
    return;
  }
  json(404, { error: 'not found' });
}

// --- 7. SRT input --------------------------------------------------------------
// A web page can't receive SRT (raw UDP). The helper listens for an SRT caller
// (Larix, vMix, an encoder...), and ffmpeg re-encodes it to H.264 + Opus and
// publishes it with WHIP to this helper's own /whip-in, which hands it to the
// studio page exactly like OBS. When the sender stops, ffmpeg exits and the
// listener starts again, so the sender can reconnect at any time.
const srt = new Map(); // id -> session

// SRT input needs an ffmpeg with SRT and the WHIP muxer (ffmpeg 8 or later).
const capsCache = new Map(); // ffmpeg path -> boolean
function ffmpegCanSrt(ff) {
  if (!ff) return false;
  if (!capsCache.has(ff)) {
    try {
      const out = (a) => spawnSync(ff, ['-hide_banner', a], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).stdout || '';
      capsCache.set(ff, /^\s*E?\s+whip\s/m.test(out('-muxers')) && /^\s+srt\s*$/m.test(out('-protocols')));
    } catch { capsCache.set(ff, false); }
  }
  return capsCache.get(ff);
}

function startSrt({ room, slot, token, port, latency, passphrase, kbps }) {
  const ff = findFfmpeg();
  if (!ff) throw Object.assign(new Error('ffmpeg is not installed on this computer. Run the helper installer again, or install ffmpeg.'), { status: 501 });
  if (!ffmpegCanSrt(ff)) throw Object.assign(new Error('The ffmpeg on this computer is too old for SRT input (it needs SRT and WHIP support, ffmpeg 8 or later). Update it with: winget upgrade Gyan.FFmpeg.Essentials'), { status: 501 });
  if (!valid(room) || !valid(slot)) throw Object.assign(new Error('bad room or source'), { status: 400 });
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Object.assign(new Error('Pick a port between 1024 and 65535.'), { status: 400 });
  if (passphrase && (passphrase.length < 10 || passphrase.length > 79)) throw Object.assign(new Error('An SRT passphrase must be 10 to 79 characters.'), { status: 400 });
  for (const o of srt.values()) {
    if (o.slot === slot && o.room === room) stopSrt(o);
    else if (o.port === port) throw Object.assign(new Error(`Port ${port} is already used by another SRT source.`), { status: 409 });
  }
  const s = { id: crypto.randomUUID(), room, slot, token: String(token || ''), port, latency: Math.max(20, Math.min(8000, Number(latency) || 200)),
    passphrase: passphrase || '', kbps: Math.max(500, Math.min(20000, Number(kbps) || 6000)), state: 'listening', input: null, stats: null,
    errors: [], last: Date.now(), p: null, stopped: false, restarts: 0 };
  srt.set(s.id, s);
  runSrt(s);
  return s;
}

function runSrt(s) {
  const ff = findFfmpeg();
  if (!ff || s.stopped) return;
  const q = new URLSearchParams({ mode: 'listener', latency: String(s.latency * 1000), transtype: 'live' });
  if (s.passphrase) { q.set('passphrase', s.passphrase); q.set('pbkeylen', '16'); }
  const gop = 60;
  const argv = ['-hide_banner', '-loglevel', 'info', '-stats', '-fflags', '+genpts', '-i', `srt://0.0.0.0:${s.port}?${q}`,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-bf', '0', '-g', String(gop), '-pix_fmt', 'yuv420p',
    '-b:v', `${s.kbps}k`, '-maxrate', `${s.kbps}k`, '-bufsize', `${s.kbps}k`,
    '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-f', 'whip', '-whip_flags', 'dtls_active', '-handshake_timeout', '10000', '-authorization', s.token,
    `http://127.0.0.1:${PORT}/whip-in/${s.room}/${s.slot}?srt=${s.id}`];
  const p = spawn(ff, argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  s.p = p; s.state = 'listening'; s.input = null; s.stats = null;
  let buf = '', inInput = false;
  p.stderr.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r|\n/); buf = lines.pop();
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (/^Input #0/.test(l)) { inInput = true; s.state = 'connecting'; s.input = { video: null, audio: null }; continue; }
      if (/^Output #0/.test(l)) inInput = false;
      if (inInput) {
        const v = /Stream #0:\d+.*?: Video: (\w+).*?(\d{2,5}x\d{2,5})/.exec(l);
        const fps = /([\d.]+) fps/.exec(l)?.[1];
        if (v && !s.input.video) s.input.video = `${v[1].toUpperCase()} ${v[2]}${fps ? ` ${Math.round(Number(fps))} fps` : ''}`;
        const a = /Stream #0:\d+.*?: Audio: (\w+)/.exec(l);
        if (a && !s.input.audio) s.input.audio = a[1];
        continue;
      }
      if (/time=\s*\S+/.test(l) && /bitrate=/.test(l)) {
        const f = (k) => (new RegExp(`${k}=\\s*([^\\s]+)`).exec(l) || [])[1];
        s.state = 'receiving';
        s.stats = { fps: Number(f('fps')) || 0, time: (f('time') || '').replace(/\.\d+$/, ''), speed: parseFloat(f('speed')) || 0 };
        continue;
      }
      if (!/error|fail|invalid|denied|refused|unable|cannot|could not|unauthori/i.test(l)) continue;
      s.errors.push(l.replace(/^\[[^\]]*\]\s*/, '')); if (s.errors.length > 8) s.errors.shift();
    }
  });
  p.on('error', (e) => { s.errors.push(e.message); });
  p.on('exit', (code) => {
    if (s.p === p) s.p = null;
    for (const close of s.relays?.splice(0) || []) close();
    if (s.stopped) return;
    const was = s.state;
    s.state = 'listening'; s.stats = null;
    if (was !== 'listening') log(`SRT ${s.slot} on port ${s.port}: sender gone (ffmpeg exit ${code}) ${s.errors.slice(-2).join(' | ')}; listening again`);
    // A listener that dies at once (port taken, bad option) would spin: back off.
    s.restarts = was === 'listening' ? s.restarts + 1 : 0;
    if (s.restarts > 3) s.state = 'error';
    setTimeout(() => runSrt(s), Math.min(10000, 500 * 2 ** Math.min(s.restarts, 5)));
  });
  log(`SRT ${s.slot}: listening on port ${s.port} (latency ${s.latency} ms${s.passphrase ? ', encrypted' : ''})`);
}

function stopSrt(s) {
  if (!s) return;
  s.stopped = true;
  srt.delete(s.id);
  for (const close of s.relays?.splice(0) || []) close();
  if (s.p) { const p = s.p; p.kill(); setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 3000); }
  log(`SRT ${s.slot}: stopped listening on port ${s.port}`);
}
const srtStatus = (s) => ({ id: s.id, state: s.state, port: s.port, latency: s.latency, encrypted: !!s.passphrase, input: s.input, stats: s.stats,
  error: s.state === 'error' ? (s.errors.slice(-3).join(' ') || 'ffmpeg could not listen on this port.') : null, lan: lanIPv4() });
// The page polls while it wants the listener; stop once it has gone away. The
// limit is generous because browsers slow timers down in background tabs.
setInterval(() => { for (const s of srt.values()) if (Date.now() - s.last > 150000) { log(`SRT ${s.slot}: studio page gone, stopping`); stopSrt(s); } }, 5000).unref();

async function handleSrt(req, res, parts) {
  const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
  if (parts.length === 1 && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: 'bad json' }); return; }
    try { json(201, srtStatus(startSrt(body))); } catch (e) { json(e.status || 500, { error: e.message }); }
    return;
  }
  const s = srt.get(parts[1]);
  if (!s) { json(404, { error: 'This SRT listener has stopped.' }); return; }
  if (req.method === 'GET') { s.last = Date.now(); json(200, srtStatus(s)); return; }
  if (req.method === 'DELETE') { stopSrt(s); json(200, { ok: true }); return; }
  json(405, { error: 'method not allowed' });
}

// ffmpeg's WHIP muxer stops answering ICE connectivity checks once it is
// connected, so Chrome's consent checks go unanswered and Chrome drops the
// connection after about 30 s. For our own ffmpeg, put a small UDP relay in the
// middle that forwards everything and answers those checks on ffmpeg's behalf.
const STUN_COOKIE = 0x2112a442;
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function stunBindingResponse(req, pwd, addr, port) {
  const xport = port ^ (STUN_COOKIE >>> 16);
  const ip = addr.split('.').map(Number);
  const cookie = [0x21, 0x12, 0xa4, 0x42];
  const xma = Buffer.from([0x00, 0x20, 0x00, 0x08, 0x00, 0x01, xport >> 8, xport & 0xff, ...ip.map((b, i) => b ^ cookie[i])]);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(0x0101, 0);
  head.writeUInt32BE(STUN_COOKIE, 4);
  req.copy(head, 8, 8, 20);
  // MESSAGE-INTEGRITY covers everything before it, with the length already counting it.
  head.writeUInt16BE(xma.length + 24, 2);
  const mi = crypto.createHmac('sha1', pwd).update(Buffer.concat([head, xma])).digest();
  const miAttr = Buffer.concat([Buffer.from([0x00, 0x08, 0x00, 0x14]), mi]);
  head.writeUInt16BE(xma.length + 24 + 8, 2);
  const body = Buffer.concat([head, xma, miAttr]);
  const fp = Buffer.alloc(8);
  fp.writeUInt16BE(0x8028, 0); fp.writeUInt16BE(4, 2); fp.writeUInt32BE((crc32(body) ^ 0x5354554e) >>> 0, 4);
  return Buffer.concat([body, fp]);
}

// Returns the answer with its candidate pointing at the relay.
async function relayForFfmpeg(s, offer, answer) {
  const pwd = /^a=ice-pwd:(\S+)/m.exec(offer)?.[1];
  const cand = /^(a=candidate:\S+ 1 udp \d+ )(\d+\.\d+\.\d+\.\d+) (\d+)( typ host[^\r\n]*)/im.exec(answer);
  if (!pwd || !cand) return answer;
  const browser = { address: cand[2], port: Number(cand[3]) };
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => { sock.once('error', reject); sock.bind(0, '0.0.0.0', resolve); });
  sock.removeAllListeners('error');
  sock.on('error', (e) => log(`SRT ${s.slot}: relay error ${e.message}`));
  // ffmpeg reaches the relay on 127.0.0.1; everything else is the browser,
  // which may also check from its other local addresses.
  let ffmpeg = null;
  sock.on('message', (msg, from) => {
    if (from.address === '127.0.0.1') {
      ffmpeg = { address: from.address, port: from.port };
      sock.send(msg, browser.port, browser.address);
      return;
    }
    // Binding request from the browser: answer it here (ffmpeg would ignore it).
    if (msg.length >= 20 && msg.readUInt16BE(0) === 0x0001 && msg.readUInt32BE(4) === STUN_COOKIE) {
      if (net.isIPv4(from.address)) sock.send(stunBindingResponse(msg, pwd, from.address, from.port), from.port, from.address);
      return;
    }
    if (ffmpeg) sock.send(msg, ffmpeg.port, ffmpeg.address);
  });
  const close = () => { try { sock.close(); } catch { /* already closed */ } };
  s.relays = (s.relays || []).filter((r) => { r(); return false; });
  s.relays.push(close);
  const { port } = sock.address();
  return answer.replace(cand[0], `${cand[1]}127.0.0.1 ${port}${cand[4]}`);
}

async function handle(req, res) {
  cors(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (req.method === 'OPTIONS') { res.writeHead(204, parts[0] === 'whip-in' || parts[0] === 'whip-session' ? { 'Accept-Post': 'application/sdp', 'Accept-Patch': 'application/trickle-ice-sdpfrag' } : {}).end(); return; }
  if (parts[0] === 'helper' && parts.length === 1) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ app: 'webrtc-studio-helper', version: VERSION, features: ['relay', 'forward', 'whip-in', 'whip-test', ...(findFfmpeg() ? ['rtmp'] : []), ...(ffmpegCanSrt(findFfmpeg()) ? ['srt'] : [])], lan: lanIPv4(), port: PORT, ffmpeg: !!findFfmpeg() }));
    return;
  }

  if (parts[0] === 'srt' && (parts.length === 1 || (parts.length === 2 && /^[0-9a-f-]{36}$/.test(parts[1])))) { await handleSrt(req, res, parts); return; }
  if (parts[0] === 'rtmp' && (parts.length === 1 || (parts.length <= 3 && /^[0-9a-f-]{36}$/.test(parts[1])))) { await handleRtmp(req, res, parts); return; }

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
    const sdp = fixSsrcGroups(await readBody(req));
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
    const bridge = local && srt.get(url.searchParams.get('srt') || '');
    if (bridge) answer = await relayForFfmpeg(bridge, sdp, answer);
    log(`  -> 201 answer ${candSummary(answer)}`);
    if (process.env.WHIP_DEBUG) log(`  OFFER:\n${sdp}\n  ANSWER:\n${answer}`);
    sessions.set(id, { room, slot, kind: 'in' });
    res.writeHead(201, { 'Content-Type': 'application/sdp', 'Content-Length': Buffer.byteLength(answer), ETag: `"${id}"`, 'Accept-Patch': 'application/trickle-ice-sdpfrag', Location: `${url.protocol}//${req.headers.host}/whip-session/${id}` }).end(answer);
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
    res.writeHead(200, { 'Content-Length': 0 }).end();
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
    console.log('  SRT in:    /srt    (listeners started from the studio page)');
    console.log(`  RTMP out:  /rtmp   (ffmpeg: ${findFfmpeg() || 'not found'})`);
    if (STATIC) console.log(`  static:    ${path.resolve(STATIC)}`);
  });
