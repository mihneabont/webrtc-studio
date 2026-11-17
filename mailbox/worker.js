// Mailbox for WebRTC Studio (Cloudflare Worker + one Durable Object per box).
//
// A web page can't receive HTTP requests or find another browser by itself, so
// this worker is the meeting point. Each studio source has its own box; the
// studio keeps a WebSocket open to it.
//  - WHIP: an encoder (OBS, Larix, a hardware encoder) POSTs its SDP offer to
//    the box's WHIP URL; the worker hands it to the studio and returns the
//    studio's answer.
//  - Guest links: the guest page opens a WebSocket to the same box and the two
//    pages swap their connection details through it, so one link keeps working
//    and reconnects by itself.
//  - TURN (optional): hands out short-lived Cloudflare TURN credentials so
//    connections also work between strict networks.
// Only a few kilobytes of connection details pass through here; the video goes
// directly between the encoder or guest and the studio's browser (or through
// TURN when it has to). Nothing is logged or stored except each box's key.
//
//   GET    /ice                      {iceServers} for the pages (STUN, plus TURN if set up)
//   GET    /studio/<box>?key=<key>   WebSocket for the studio (the first key used
//                                   claims the box; later connections must match)
//   GET    /guest/<box>              WebSocket for a guest page
//   POST   /whip/<box>               encoder offer -> 201 + answer
//   PATCH  /whip/<box>/<session>     trickled ICE candidates (sdpfrag)
//   DELETE /whip/<box>/<session>     encoder stopped
//
// Optional settings (Cloudflare dashboard → Worker → Settings → Variables):
//   TURN_KEY_ID, TURN_KEY_API_TOKEN  a Cloudflare Realtime TURN key (secret)
//   ALLOWED_ORIGINS                  e.g. https://you.github.io; only these pages
//                                    get TURN credentials (comma-separated)

const BOX = /^[A-Za-z0-9_-]{16,64}$/;
const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const ANSWER_TIMEOUT_MS = 20000;
const IDLE_EXPIRY_MS = 60 * 24 * 3600 * 1000; // forget a box 60 days after its studio was last connected
const TURN_TTL_S = 12 * 3600;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
  'Access-Control-Expose-Headers': 'Location, Link, ETag, Accept-Patch, Retry-After',
};

function reply(status, body = '', headers = {}) {
  return new Response(body || null, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...(body ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}), ...headers } });
}

// --- ICE servers --------------------------------------------------------------

let turnCache = null; // { at, servers }

async function iceServers(env) {
  const servers = [{ urls: STUN }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return servers;
  if (turnCache && Date.now() - turnCache.at < 3600 * 1000) return [...servers, ...turnCache.servers];
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
    });
    if (!r.ok) throw new Error(`TURN credentials: HTTP ${r.status}`);
    const j = await r.json();
    const list = [].concat(j.iceServers || []);
    // Keep only the TURN entries; STUN is already listed. Port 53 is blocked by most browsers.
    const turn = list.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => /^turns?:/.test(u) && !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length && s.username);
    turnCache = { at: Date.now(), servers: turn };
    return [...servers, ...turn];
  } catch (e) {
    console.warn(String(e));
    return servers;
  }
}

function originAllowed(req, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(/[\s,]+/).filter(Boolean);
  if (!allowed.length) return true;
  const origin = req.headers.get('Origin') || '';
  return allowed.some((a) => a.replace(/\/+$/, '') === origin);
}

// WHIP encoders read ICE servers from Link headers (RFC 9725).
function linkHeader(servers) {
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  return servers.flatMap((s) => [].concat(s.urls).map((u) => `<${u}>; rel="ice-server"${s.username ? `; username=${q(s.username)}; credential=${q(s.credential)}; credential-type="password"` : ''}`)).join(', ');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const [, area, box, session] = url.pathname.split('/');
    if (req.method === 'OPTIONS') {
      return reply(204, '', { 'Accept-Post': 'application/sdp', 'Access-Control-Max-Age': '86400' });
    }
    if (!area) return reply(200, 'WebRTC Studio mailbox. Paste a WHIP link from the studio into your encoder.');
    if (area === 'ice' && req.method === 'GET') {
      const servers = originAllowed(req, env) ? await iceServers(env) : [{ urls: STUN }];
      return new Response(JSON.stringify({ iceServers: servers }), { headers: { ...CORS, 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } });
    }
    if (!['studio', 'guest', 'whip'].includes(area) || !BOX.test(box || '')) return reply(404, 'Not found.');
    if (area !== 'whip' && session) return reply(404, 'Not found.');
    const stub = env.BOX.get(env.BOX.idFromName(box));
    if (area === 'whip' && req.method === 'POST') {
      // Pass the ICE servers along so the box doesn't need the secrets.
      const headers = new Headers(req.headers);
      headers.set('X-Mailbox-Link', linkHeader(await iceServers(env)));
      return stub.fetch(new Request(req, { headers }));
    }
    return stub.fetch(req);
  },
};

// --- one box --------------------------------------------------------------------

export class Box {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Map(); // WHIP session -> { resolve, timer }
    // Answer keep-alive pings without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, area, box, session] = url.pathname.split('/');
    if (area === 'studio') return this.studio(req, url);
    if (area === 'guest') return this.guest(req);
    if (req.method === 'POST' && !session) return this.offer(req, url, box);
    if (req.method === 'PATCH' && session) return this.toStudio({ type: 'whip-candidate', sid: session, frag: (await req.text()).slice(0, 16384) }, 204);
    if (req.method === 'DELETE' && session) return this.toStudio({ type: 'whip-end', sid: session }, 200);
    return reply(405, 'Method not allowed.');
  }

  sockets(tag) { return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === 1); }
  studioSocket() { return this.sockets('studio')[0] || null; }
  static send(ws, msg) { try { ws.send(JSON.stringify(msg)); return true; } catch { return false; } }

  // The studio's WebSocket. The first key ever used claims this box.
  async studio(req, url) {
    if (req.headers.get('Upgrade') !== 'websocket') return reply(426, 'Expected a WebSocket.');
    const key = url.searchParams.get('key') || '';
    if (key.length < 16) return reply(403, 'Missing key.');
    const hash = await sha256(key);
    const owner = await this.ctx.storage.get('owner');
    if (owner && owner !== hash) return reply(403, 'This box belongs to another studio.');
    if (!owner) await this.ctx.storage.put('owner', hash);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_EXPIRY_MS);
    // One studio per box: a reloaded studio (or another tab) takes over.
    for (const ws of this.ctx.getWebSockets('studio')) { try { ws.close(4000, 'Replaced by a newer studio connection.'); } catch { /* gone */ } }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['studio']);
    for (const g of this.sockets('guest')) Box.send(g, { type: 'studio-online' });
    Box.send(server, { type: 'guests', count: this.sockets('guest').length });
    return new Response(null, { status: 101, webSocket: client });
  }

  // A guest page. One guest per box: a newer one (a refresh, another device) takes over.
  guest(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return reply(426, 'Expected a WebSocket.');
    for (const ws of this.ctx.getWebSockets('guest')) { try { ws.close(4001, 'The link was opened somewhere else.'); } catch { /* gone */ } }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['guest']);
    Box.send(server, { type: this.studioSocket() ? 'studio-online' : 'studio-offline' });
    return new Response(null, { status: 101, webSocket: client });
  }

  async offer(req, url, box) {
    const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/sdp') return reply(415, 'WHIP offers must be sent as application/sdp.');
    const sdp = await req.text();
    if (!sdp.startsWith('v=0') || sdp.length > 64 * 1024) return reply(400, 'That is not an SDP offer.');
    const ws = this.studioSocket();
    if (!ws) return reply(503, 'The studio is not open. Open the studio page, then start streaming again.', { 'Retry-After': '5' });
    const sid = crypto.randomUUID().replace(/-/g, '');
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(sid); resolve({ type: 'whip-reject', status: 504, reason: 'The studio did not answer in time.' }); }, ANSWER_TIMEOUT_MS);
      this.pending.set(sid, { resolve, timer });
      if (!Box.send(ws, { type: 'whip-offer', sid, sdp, auth: req.headers.get('Authorization') || '' })) {
        clearTimeout(timer); this.pending.delete(sid);
        resolve({ type: 'whip-reject', status: 503, reason: 'The studio is not open.' });
      }
    });
    if (result.type !== 'whip-answer') {
      const status = [400, 401, 403, 404, 409, 415, 503, 504].includes(result.status) ? result.status : 400;
      return reply(status, String(result.reason || 'Refused by the studio.').slice(0, 500), result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {});
    }
    const link = req.headers.get('X-Mailbox-Link');
    return new Response(String(result.sdp), {
      status: 201,
      headers: {
        ...CORS, 'Cache-Control': 'no-store', 'Content-Type': 'application/sdp',
        Location: `${url.origin}/whip/${box}/${sid}`, ETag: `"${sid}"`, 'Accept-Patch': 'application/trickle-ice-sdpfrag',
        ...(link ? { Link: link } : {}),
      },
    });
  }

  toStudio(msg, ok) {
    const ws = this.studioSocket();
    if (ws) Box.send(ws, msg);
    return reply(ok);
  }

  webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 64 * 1024) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const [tag] = this.ctx.getTags(ws);
    if (tag === 'guest') {
      // Guest -> studio. Tell the guest when there is nobody to hear it.
      const studio = this.studioSocket();
      if (!studio) return Box.send(ws, { type: 'studio-offline' });
      Box.send(studio, { ...m, from: 'guest' });
      return;
    }
    if (m.to === 'guest') {
      const { to, ...rest } = m;
      for (const g of this.sockets('guest')) Box.send(g, rest);
      return;
    }
    const p = this.pending.get(m.sid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.sid);
    p.resolve(m);
  }

  webSocketClose(ws, code) {
    try { ws.close(code >= 1005 && code <= 1015 ? 1000 : code, 'bye'); } catch { /* already closed */ }
    const [tag] = this.ctx.getTags(ws);
    if (tag === 'guest' && code !== 4001) { const s = this.studioSocket(); if (s) Box.send(s, { type: 'guest-left' }); }
    if (tag === 'studio' && code !== 4000 && !this.studioSocket()) for (const g of this.sockets('guest')) Box.send(g, { type: 'studio-offline' });
  }

  async alarm() {
    // No studio has used this box for a long time: forget it.
    if (this.studioSocket()) return this.ctx.storage.setAlarm(Date.now() + IDLE_EXPIRY_MS);
    await this.ctx.storage.deleteAll();
  }
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
