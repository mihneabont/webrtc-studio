// WebRTC helpers shared by the studio, contributor and receiver pages:
// ICE configuration, non-trickle gathering, codec preferences, statistics,
// failure diagnosis, and WHIP/WHEP HTTP signaling clients.

export const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

export function buildIceServers(ice = {}) {
  const servers = [];
  const stun = (ice.stun ?? DEFAULT_STUN).split(/[\s,]+/).filter(Boolean);
  if (stun.length) servers.push({ urls: stun });
  if (ice.turnUrl) {
    servers.push({
      urls: ice.turnUrl.split(/[\s,]+/).filter(Boolean),
      username: ice.turnUser || undefined,
      credential: ice.turnPass || undefined,
    });
  }
  return servers;
}

export function rtcConfig(ice = {}) {
  return {
    iceServers: buildIceServers(ice),
    iceTransportPolicy: ice.forceRelay ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
  };
}

// Serverless signaling can't trickle candidates, so we wait for gathering to
// finish (or a timeout, after which whatever was gathered is used).
export function waitForIceGathering(pc, timeoutMs = 5000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let srflxSeen = false;
    const done = () => {
      clearTimeout(t); clearTimeout(early);
      pc.removeEventListener('icegatheringstatechange', onState);
      pc.removeEventListener('icecandidate', onCand);
      resolve();
    };
    const onState = () => { if (pc.iceGatheringState === 'complete') done(); };
    // Some networks make a STUN/TURN server hang until timeout; once we have
    // a server-reflexive or relay candidate, give stragglers a little longer only.
    let early;
    const onCand = (e) => {
      if (!e.candidate) return done();
      if (!srflxSeen && /typ (srflx|relay)/.test(e.candidate.candidate)) {
        srflxSeen = true;
        early = setTimeout(done, 1500);
      }
    };
    const t = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCand);
  });
}

export function codecSupported(kind, mime) {
  const caps = RTCRtpSender.getCapabilities?.(kind);
  return !!caps?.codecs.some((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
}

// Put the wanted codec(s) first; with `only` drop everything else (except
// RTX/RED/FEC helpers). Returns false if the codec isn't available.
export function preferCodec(transceiver, mime, { only = false } = {}) {
  const kind = transceiver.receiver.track.kind;
  const caps = RTCRtpSender.getCapabilities?.(kind);
  if (!caps || !transceiver.setCodecPreferences) return false;
  const want = caps.codecs.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
  if (!want.length) return false;
  // Prefer packetization-mode=1 constrained baseline for H.264: it is the
  // profile every H.264 WebRTC ingest accepts.
  if (mime.toLowerCase() === 'video/h264') {
    const score = (c) => {
      const f = c.sdpFmtpLine || '';
      return (f.includes('packetization-mode=1') ? 0 : 10) + (f.includes('profile-level-id=42e0') ? 0 : f.includes('profile-level-id=4200') ? 1 : 2);
    };
    want.sort((a, b) => score(a) - score(b));
  }
  const helpers = caps.codecs.filter((c) => /\/(rtx|red|ulpfec|flexfec)/i.test(c.mimeType));
  const rest = only ? [] : caps.codecs.filter((c) => !want.includes(c) && !helpers.includes(c));
  try {
    transceiver.setCodecPreferences([...want, ...rest, ...helpers]);
    return true;
  } catch (e) {
    console.warn('setCodecPreferences failed', e);
    return false;
  }
}

export function sdpCodecs(sdp) {
  const out = {};
  let kind = null;
  for (const line of (sdp || '').split(/\r?\n/)) {
    const m = line.match(/^m=(\w+) \d+ \S+ ([\d ]+)/);
    if (m) { kind = m[1]; out[kind] = { pts: m[2].split(' '), names: [] }; continue; }
    const r = line.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (r && kind && out[kind].pts[0] === r[1]) out[kind].names.push(r[2]);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.names[0] || null]));
}

// ---------------------------------------------------------------------------
// Statistics. Everything shown in the UI comes from RTCPeerConnection.getStats;
// fields the browser doesn't report stay undefined and render as "–".

export class StatsSampler {
  constructor(pc) { this.pc = pc; this.prev = null; }

  async sample() {
    if (!this.pc || this.pc.connectionState === 'closed') return null;
    let report;
    try { report = await this.pc.getStats(); } catch { return null; }
    const s = summarize(report, this.prev);
    this.prev = report;
    return s;
  }
}

function rate(cur, prev, field) {
  if (!prev || cur[field] === undefined || prev[field] === undefined) return undefined;
  const dt = (cur.timestamp - prev.timestamp) / 1000;
  if (dt <= 0) return undefined;
  return ((cur[field] - prev[field]) * 8) / dt / 1000; // kbps
}

export function summarize(report, prevReport) {
  const get = (id) => (id ? report.get(id) : undefined);
  const prev = (id) => (id && prevReport ? prevReport.get(id) : undefined);
  const out = { in: {}, out: {}, pair: null, ts: Date.now() };
  let selectedPairId = null;

  report.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) selectedPairId = s.selectedCandidatePairId;
  });

  report.forEach((s) => {
    const p = prev(s.id);
    if (s.type === 'inbound-rtp') {
      const codec = get(s.codecId)?.mimeType?.split('/')[1];
      const lostDelta = p ? (s.packetsLost - p.packetsLost) : 0;
      const recvDelta = p ? (s.packetsReceived - p.packetsReceived) : 0;
      const loss = recvDelta + lostDelta > 0 ? Math.max(0, lostDelta) / (recvDelta + lostDelta) : 0;
      if (s.kind === 'video') {
        out.in.video = {
          width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond,
          kbps: rate(s, p, 'bytesReceived'), codec, loss, jitter: s.jitter,
          dropped: s.framesDropped, freezes: s.freezeCount, decoder: s.decoderImplementation,
          receiving: p ? s.packetsReceived > p.packetsReceived : undefined,
        };
      } else if (s.kind === 'audio') {
        out.in.audio = {
          kbps: rate(s, p, 'bytesReceived'), codec, loss, level: s.audioLevel,
          receiving: p ? s.packetsReceived > p.packetsReceived : undefined,
        };
      }
    } else if (s.type === 'outbound-rtp') {
      const codec = get(s.codecId)?.mimeType?.split('/')[1];
      const remote = [...report.values()].find((r) => r.type === 'remote-inbound-rtp' && r.localId === s.id);
      const entry = {
        kbps: rate(s, p, 'bytesSent'), codec, rtt: remote?.roundTripTime, loss: remote?.fractionLost,
      };
      if (s.kind === 'video') {
        Object.assign(entry, {
          width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond,
          target: s.targetBitrate ? s.targetBitrate / 1000 : undefined,
          limitation: s.qualityLimitationReason, encoder: s.encoderImplementation,
          keyframes: s.keyFramesEncoded, pli: s.pliCount, nack: s.nackCount,
        });
        // Simulcast would yield several; keep the highest-resolution one.
        if (!out.out.video || (entry.width || 0) > (out.out.video.width || 0)) out.out.video = entry;
      } else if (s.kind === 'audio') {
        out.out.audio = entry;
      }
    } else if (s.type === 'candidate-pair' && (s.id === selectedPairId || (!selectedPairId && s.nominated && s.state === 'succeeded'))) {
      const lc = get(s.localCandidateId), rc = get(s.remoteCandidateId);
      out.pair = {
        rtt: s.currentRoundTripTime,
        availOut: s.availableOutgoingBitrate ? s.availableOutgoingBitrate / 1000 : undefined,
        availIn: s.availableIncomingBitrate ? s.availableIncomingBitrate / 1000 : undefined,
        local: lc ? `${lc.candidateType}${lc.relayProtocol ? '/' + lc.relayProtocol : ''} ${lc.protocol}` : undefined,
        remote: rc ? `${rc.candidateType} ${rc.protocol}` : undefined,
        relayed: lc?.candidateType === 'relay' || rc?.candidateType === 'relay',
      };
    }
  });
  out.health = health(out);
  return out;
}

function health(s) {
  const v = s.in.video || s.out.video;
  const a = s.in.audio || s.out.audio;
  const loss = Math.max(v?.loss || 0, a?.loss || 0);
  const rtt = s.pair?.rtt ?? 0;
  if (s.in.video && s.in.video.receiving === false) return 'bad';
  if (loss > 0.05 || rtt > 0.5) return 'bad';
  if (loss > 0.01 || rtt > 0.2 || (s.out.video?.limitation && s.out.video.limitation !== 'none')) return 'warn';
  return 'good';
}

// Explain an ICE failure using what the connection actually gathered.
export async function diagnoseFailure(pc, iceServers) {
  const lines = [];
  let local = [], remote = [];
  try {
    const r = await pc.getStats();
    r.forEach((s) => {
      if (s.type === 'local-candidate') local.push(s.candidateType);
      if (s.type === 'remote-candidate') remote.push(s.candidateType);
    });
  } catch { /* closed */ }
  const hasStun = iceServers.some((s) => [].concat(s.urls).some((u) => /^stuns?:/.test(u)));
  const hasTurn = iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
  if (hasStun && !local.includes('srflx') && !local.includes('relay')) {
    lines.push('No public address was discovered: the STUN server is unreachable from this network.');
  }
  if (hasTurn && !local.includes('relay')) {
    lines.push('The TURN server did not provide a relay address: check its URL and credentials.');
  }
  if (!hasTurn) {
    lines.push('A direct peer-to-peer path could not be found. Strict NATs and firewalls block direct WebRTC; adding a TURN server in Settings (optional infrastructure) fixes this.');
  } else {
    lines.push('Even the relay path failed: the TURN server may be blocked, or the peer has gone away.');
  }
  if (remote.length && remote.every((t) => t === 'host')) {
    lines.push('The other side only offered local-network addresses.');
  }
  return lines.join(' ');
}

// ---------------------------------------------------------------------------
// WHIP (RFC 9725) / WHEP HTTP signaling.

export class HttpSignalError extends Error {
  constructor(message, { status, kind } = {}) { super(message); this.status = status; this.kind = kind; }
}

function viaProxy(url, proxy) {
  if (!proxy) return url;
  return `${proxy.replace(/\/+$/, '')}/forward?target=${encodeURIComponent(url)}`;
}

function explainStatus(status, body, what) {
  const tail = body ? ` Server said: ${body.slice(0, 200)}` : '';
  switch (status) {
    case 400: return `The ${what} endpoint rejected the offer (400). It may not accept the codec or SDP the browser produced.${tail}`;
    case 401: case 403: return `Authentication failed (${status}). Check the stream key or bearer token.${tail}`;
    case 404: return `Endpoint not found (404). Check the URL.${tail}`;
    case 405: return `The endpoint does not accept this request method (405). Is this really a ${what} URL?${tail}`;
    case 406: case 415: return `The endpoint refused the SDP content type (${status}).${tail}`;
    case 409: return `Conflict (409): a session with these credentials may already be live.${tail}`;
    case 429: case 503: return `The endpoint is busy (${status}). Try again shortly.${tail}`;
    default: return `The ${what} endpoint returned HTTP ${status}.${tail}`;
  }
}

async function httpSdp({ url, token, sdp, proxy, what }) {
  const headers = { 'Content-Type': 'application/sdp' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(viaProxy(url, proxy), { method: 'POST', headers, body: sdp, mode: 'cors', redirect: 'follow' });
  } catch (e) {
    throw new HttpSignalError(
      `The browser could not complete the ${what} request. Either the endpoint is unreachable, or it does not allow requests from a web page (CORS). ` +
      (proxy ? 'The configured CORS forwarder also failed: check that it is running.' :
        'If the endpoint lacks CORS support, set the optional WHIP/WHEP CORS forwarder in Settings (it relays only the SDP, never media).'),
      { kind: 'network' });
  }
  const text = await res.text().catch(() => '');
  if (res.status !== 201 && res.status !== 200) {
    throw new HttpSignalError(explainStatus(res.status, text, what), { status: res.status, kind: res.status === 401 || res.status === 403 ? 'auth' : 'http' });
  }
  if (!/^v=0/.test(text.trim())) {
    throw new HttpSignalError(`The ${what} endpoint answered ${res.status} but the body is not an SDP answer.`, { status: res.status, kind: 'http' });
  }
  const loc = res.headers.get('Location');
  // When proxied, the forwarder rewrites Location to an absolute proxied URL.
  let resourceUrl = null;
  if (loc) {
    try { resourceUrl = new URL(loc, proxy ? undefined : res.url || url).toString(); } catch { resourceUrl = loc; }
  }
  return { answer: text, resourceUrl, etag: res.headers.get('ETag') };
}

export function whipPublish(opts) { return httpSdp({ ...opts, what: 'WHIP' }); }
export function whepSubscribe(opts) { return httpSdp({ ...opts, what: 'WHEP' }); }

export async function httpTeardown(resourceUrl, token, { keepalive = false } = {}) {
  if (!resourceUrl) return;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    await fetch(resourceUrl, { method: 'DELETE', headers, keepalive, mode: 'cors' });
  } catch (e) {
    console.warn('DELETE of WHIP/WHEP resource failed', e);
  }
}
