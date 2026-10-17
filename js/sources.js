// Incoming WebRTC sources.
//  - "peer": a remote contributor opens contribute.html. Signaling either by
//    copy-paste codes (no infrastructure at all) or via the optional relay.
//  - "whep": pull from any WHEP endpoint (an external WebRTC server/encoder).
//  - "obs":  an encoder publishes with WHIP through the helper.
//  - "srt":  the helper listens for an SRT sender and converts it with ffmpeg,
//            then publishes it here like an OBS source.
// Every source has its own RTCPeerConnection, so one failing never affects
// the others.
import { Emitter, uid, relayWorksRemotely } from './util.js';
import { encodeSignal, decodeSignal } from './codec.js';
import { rtcConfig, waitForIceGathering, StatsSampler, diagnoseFailure, whepSubscribe, httpTeardown, sdpCodecs } from './rtc.js';

export const SOURCE_STATES = {
  offline: 'Not connected',
  invited: 'Waiting for contributor',
  waiting: 'Waiting for contributor',
  connecting: 'Connecting',
  live: 'Live',
  unstable: 'Unstable',
  failed: 'Failed',
  ended: 'Ended',
};

export function stateLabel(s) {
  if (s.cfg.kind === 'obs' && (s.state === 'waiting' || s.state === 'invited')) return 'Waiting for encoder';
  if (s.cfg.kind === 'srt' && (s.state === 'waiting' || s.state === 'invited')) return 'Waiting for SRT sender';
  return SOURCE_STATES[s.state] || s.state;
}

// Describes the offered media our answer rejected (port 0), e.g.
// 'video (H.264 High, 64001f)', or null if everything was accepted. Firefox,
// for example, only receives H.264 Constrained Baseline.
const H264_PROFILES = { 42: 'Baseline', '4d': 'Main', 58: 'Extended', 64: 'High' };
function mediaSections(sdp) {
  return (sdp || '').split(/\r?\nm=/).slice(1).map((sec) => {
    const [, kind, port, pts] = /^(\w+) (\d+) \S+ ?([\d ]*)/.exec(sec) || [];
    const pt = (pts || '').split(' ')[0];
    const codec = new RegExp(`a=rtpmap:${pt} ([\\w-]+)/`).exec(sec)?.[1];
    const plid = new RegExp(`a=fmtp:${pt} .*profile-level-id=([0-9a-f]{6})`, 'i').exec(sec)?.[1]?.toLowerCase();
    return { kind, port: Number(port), codec, plid };
  });
}
function rejectedMedia(offer, answer) {
  const off = mediaSections(offer), ans = mediaSections(answer);
  const bad = off.filter((o, i) => o.port !== 0 && ans[i]?.port === 0);
  if (!bad.length) return null;
  return bad.map((o) => {
    const prof = o.codec === 'H264' && o.plid ? `H.264 ${H264_PROFILES[o.plid.slice(0, 2)] || 'profile'}, ${o.plid}` : o.codec;
    return `${o.kind}${prof ? ` (${prof})` : ''}`;
  }).join(' and ');
}

export class SourceManager extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.relay = null;
    this.list = new Map(); // id -> runtime
    for (const cfg of store.ws.sources) this._makeRuntime(cfg);
    this._statsTimer = setInterval(() => this._sampleAll(), 1000);
    window.addEventListener('pagehide', () => {
      for (const s of this.list.values()) if (s.resourceUrl) httpTeardown(s.resourceUrl, s.token, { keepalive: true });
    });
  }

  get ws() { return this.store.ws; }
  get(id) { return this.list.get(id); }
  all() { return this.ws.sources.map((c) => this.list.get(c.id)).filter(Boolean); }

  _makeRuntime(cfg) {
    const s = {
      cfg, id: cfg.id, state: 'offline', detail: 'Saved configuration. Not connected in this session.',
      stream: null, hasVideo: false, hasAudio: false, videoFlowing: false, audioFlowing: false,
      pc: null, dc: null, sampler: null, stats: null, invite: null, info: null, gen: 0,
      resourceUrl: null, token: '', retries: 0, retryTimer: null, recoverTimer: null, lastLiveAt: null, tally: {},
    };
    this.list.set(cfg.id, s);
    return s;
  }

  add({ name, kind = 'peer', mode, whepUrl = '' }) {
    const cfg = {
      id: uid(4), name: name || `Source ${this.ws.sources.length + 1}`, kind,
      mode: mode || (relayWorksRemotely(this.ws.settings.signalingUrl) ? 'relay' : 'manual'), whepUrl,
    };
    if (kind === 'obs' || kind === 'srt') { cfg.mode = 'relay'; cfg.token = uid(12); }
    if (kind === 'srt') {
      const used = new Set(this.ws.sources.map((c) => c.srtPort));
      let port = 9000; while (used.has(port)) port++;
      Object.assign(cfg, { srtPort: port, srtLatency: 200, srtPass: '', srtOn: false });
    }
    this.ws.sources.push(cfg);
    this.store.save();
    const s = this._makeRuntime(cfg);
    this.emit('added', s);
    this.emit('change', s);
    return s;
  }

  remove(id) {
    const s = this.list.get(id);
    if (!s) return;
    this._teardown(s, 'removed');
    if (s.cfg.kind === 'srt') this.stopSrt(s);
    this.list.delete(id);
    this.ws.sources = this.ws.sources.filter((c) => c.id !== id);
    delete this.ws.audio.channels[id];
    this.store.save();
    this.emit('removed', id);
  }

  update(id, patch) {
    const s = this.list.get(id);
    if (!s) return;
    Object.assign(s.cfg, patch);
    this.store.save();
    if (patch.name) this._send(s, { type: 'name', name: patch.name });
    this.emit('change', s);
  }

  move(id, dir) {
    const arr = this.ws.sources;
    const i = arr.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    this.store.save();
    this.emit('reordered');
  }

  _set(s, state, detail) {
    s.state = state;
    if (detail !== undefined) s.detail = detail;
    if (state === 'live') { s.lastLiveAt = Date.now(); s.retries = 0; }
    this.emit('change', s);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle

  _newConnection(s, { answerer = false } = {}) {
    this._teardown(s, 'replaced');
    s.gen++;
    const gen = s.gen;
    const ice = this.ws.settings.ice;
    const pc = new RTCPeerConnection(rtcConfig(ice));
    s.pc = pc;
    s.sampler = new StatsSampler(pc);
    s.stats = null;
    s.stream = new MediaStream();
    s.hasVideo = s.hasAudio = false;
    s.videoFlowing = s.audioFlowing = false;
    if (!answerer) {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    pc.ontrack = (e) => {
      if (s.gen !== gen) return;
      const t = e.track;
      s.stream.addTrack(t);
      if (t.kind === 'video') s.hasVideo = true; else s.hasAudio = true;
      const flow = () => {
        if (s.gen !== gen) return;
        if (t.kind === 'video') s.videoFlowing = !t.muted; else s.audioFlowing = !t.muted;
        this.emit('change', s);
      };
      t.onmute = flow; t.onunmute = flow;
      flow();
      this.emit('media', s);
    };

    pc.onconnectionstatechange = async () => {
      if (s.gen !== gen) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        clearTimeout(s.recoverTimer);
        this._set(s, 'live', { whep: 'Receiving from WHEP endpoint.', obs: 'Receiving from the encoder (OBS/WHIP).', srt: 'Receiving the SRT stream (converted by the helper).' }[s.cfg.kind] || 'Receiving from contributor.');
        this._sendTally(s, true);
      } else if (st === 'disconnected') {
        this._set(s, 'unstable', 'Connection interrupted. The browser is trying to recover it…');
        clearTimeout(s.recoverTimer);
        s.recoverTimer = setTimeout(() => {
          if (s.gen === gen && pc.connectionState !== 'connected') this._autoRecover(s, 'Connection did not recover.');
        }, 8000);
      } else if (st === 'failed') {
        const why = await diagnoseFailure(pc, rtcConfig(ice).iceServers);
        if (s.gen !== gen) return;
        this._set(s, 'failed', `Connection failed. ${why}`);
        this._autoRecover(s, `Connection failed. ${why}`);
      }
    };

    if (answerer) { this.emit('media', s); return { pc, gen }; }
    const dc = pc.createDataChannel('studio', { ordered: true });
    s.dc = dc;
    dc.onopen = () => {
      if (s.gen !== gen) return;
      this._send(s, { type: 'hello', name: s.cfg.name });
      this._sendTally(s, true);
    };
    dc.onmessage = (e) => {
      if (s.gen !== gen) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'info') { s.info = m; this.emit('change', s); }
      if (m.type === 'bye') {
        this._teardown(s, 'bye');
        this._set(s, 'ended', 'The contributor ended the stream.');
      }
    };
    this.emit('media', s); // new (empty) stream: consumers rebind
    return { pc, gen };
  }

  _teardown(s, why) {
    clearTimeout(s.retryTimer); clearTimeout(s.recoverTimer);
    if (s.resourceUrl) { httpTeardown(s.resourceUrl, s.token); s.resourceUrl = null; }
    if (s.dc && s.dc.readyState === 'open' && why === 'disconnect') {
      try { s.dc.send(JSON.stringify({ type: 'bye' })); } catch { /* ignore */ }
    }
    if (s.pc) { try { s.pc.close(); } catch { /* ignore */ } }
    if (s.stream) for (const t of s.stream.getTracks()) t.stop();
    s.pc = null; s.dc = null; s.sampler = null; s.invite = null;
    s.gen++;
    if (s.stream) { s.stream = null; s.hasAudio = s.hasVideo = false; s.videoFlowing = s.audioFlowing = false; this.emit('media', s); }
  }

  disconnect(id) {
    const s = this.list.get(id);
    if (!s) return;
    if (s.cfg.mode === 'relay' && s.cfg.kind === 'peer') this._relaySend(`src-${s.id}`, { type: 'bye' });
    this._teardown(s, 'disconnect');
    if (s.cfg.kind === 'obs') s.blocked = true;
    if (s.cfg.kind === 'srt') { this.stopSrt(s); this.update(s.id, { srtOn: false }); }
    this._set(s, 'offline', s.cfg.kind === 'obs' ? 'Disconnected by operator. Encoder connections are refused until you click Accept encoder.'
      : s.cfg.kind === 'srt' ? 'Stopped. The helper is not listening for this SRT source.' : 'Disconnected by operator.');
  }

  // Manual (copy-paste) signaling ------------------------------------------

  async createInvite(id) {
    const s = this.list.get(id);
    const { pc, gen } = this._newConnection(s);
    this._set(s, 'connecting', 'Preparing invite (gathering network addresses)…');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    if (s.gen !== gen) return null;
    const code = await encodeSignal({ t: 'offer', role: 'contribute', slot: s.id, name: s.cfg.name, ice: this.ws.settings.ice, sdp: pc.localDescription.sdp });
    const link = new URL(`contribute.html#c=${code}`, location.href).toString();
    s.invite = { code, link, at: Date.now() };
    this._set(s, 'invited', 'Send the invite link to the contributor, then paste their reply code here.');
    return s.invite;
  }

  async acceptAnswer(id, text) {
    const s = this.list.get(id);
    if (!s?.pc || s.pc.signalingState !== 'have-local-offer') {
      throw new Error('This source has no pending invite. Create a new invite first.');
    }
    const msg = await decodeSignal(text);
    if (msg.t !== 'answer') throw new Error('That is not a reply code. Paste the code shown on the contributor page.');
    if (msg.slot && msg.slot !== s.id) {
      const other = this.list.get(msg.slot);
      throw new Error(`That reply belongs to ${other ? `"${other.cfg.name}"` : 'another source'}.`);
    }
    await s.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    s.invite = null;
    this._set(s, 'connecting', 'Reply accepted. Establishing connection…');
  }

  // Optional relay signaling -------------------------------------------------

  attachRelay(relay) {
    this.relay = relay;
    relay?.on('message', (m) => this._onRelay(m));
    relay?.on('state', (st) => {
      if (st === 'open') {
        // After a studio reload, ask every relay contributor to say hello again.
        for (const s of this.list.values()) {
          if (s.cfg.kind === 'obs' && s.state === 'offline') this._set(s, 'waiting', 'Waiting for the encoder. Start streaming in OBS.');
          if (s.cfg.kind === 'srt' && s.cfg.srtOn && !s.srt) this.startSrt(s.id);
          if (s.cfg.kind === 'peer' && s.cfg.mode === 'relay' && s.state !== 'live') {
            this._relaySend(`src-${s.id}`, { type: 'rehello' });
            if (s.state === 'offline') this._set(s, 'waiting', 'Waiting for the contributor to open their link.');
          }
        }
      }
    });
  }

  relayLink(id) {
    const s = this.list.get(id);
    const st = this.ws.settings;
    const p = new URLSearchParams({ sig: st.signalingUrl, room: st.room, slot: s.id, name: s.cfg.name });
    return new URL(`contribute.html#${p}`, location.href).toString();
  }

  _relaySend(to, msg) {
    if (!this.relay) return;
    this.relay.send(to, msg).catch((e) => console.warn('relay send failed', e));
  }

  obsUrl(id) {
    const st = this.ws.settings;
    return st.signalingUrl ? `${st.signalingUrl}/whip-in/${encodeURIComponent(st.room)}/${encodeURIComponent(id)}` : '';
  }

  // OBS / WHIP encoder ingest. The helper turns the encoder's HTTP POST into
  // a relay message; we answer, and media flows encoder -> this browser.
  async _onIngest(m) {
    const reply = (msg) => this._relaySend('ingest', { gen: m.gen, ...msg });
    const s = this.list.get(m.slot);
    if (m.type === 'whip-bye') {
      if (s && s.whipGen === m.gen) {
        this._teardown(s, 'bye');
        if (s.cfg.kind === 'srt') this._set(s, 'waiting', 'The SRT sender stopped. The helper is listening again; the sender can reconnect.');
        else this._set(s, 'ended', 'The encoder stopped streaming.');
      }
      return;
    }
    if (m.type === 'whip-trickle') {
      if (!s?.pc || s.whipGen !== m.gen) return;
      let mid = null;
      for (const line of String(m.frag || '').split(/\r?\n/)) {
        if (line.startsWith('a=mid:')) mid = line.slice(6).trim();
        else if (line.startsWith('a=candidate:')) {
          s.pc.addIceCandidate({ candidate: line.slice(2).trim(), sdpMid: mid ?? s.pc.getTransceivers()[0]?.mid ?? '0' })
            .catch((e) => console.warn('encoder candidate rejected', e));
        }
      }
      return;
    }
    if (m.type !== 'whip-offer') return;
    if (!s || (s.cfg.kind !== 'obs' && s.cfg.kind !== 'srt')) return reply({ type: 'reject', status: 404, reason: 'No such source in the studio. Copy the server URL again.' });
    if ((m.auth || '').replace(/^Bearer\s+/i, '') !== s.cfg.token) {
      this._set(s, s.state, 'An encoder tried to connect with a wrong bearer token.');
      return reply({ type: 'reject', status: 401, reason: 'Wrong bearer token.' });
    }
    if (s.blocked) return reply({ type: 'reject', status: 403, reason: 'This source is disconnected in the studio.' });
    try {
      const { pc, gen } = this._newConnection(s, { answerer: true });
      s.whipGen = m.gen;
      this._set(s, 'connecting', 'Encoder connected. Negotiating media…');
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      for (const t of pc.getTransceivers()) t.direction = 'recvonly';
      const answer = await pc.createAnswer();
      // Encoder on the studio's own machine (OBS): let it start the DTLS
      // handshake. Chrome as DTLS client sends a large (post-quantum) hello
      // that OBS's DTLS stack fails on at once; as server it follows OBS.
      if (m.local) answer.sdp = answer.sdp.replace(/^a=setup:active/gm, 'a=setup:passive');
      await pc.setLocalDescription(answer);
      const rejected = rejectedMedia(m.sdp, pc.localDescription.sdp);
      if (rejected) {
        const reason = `This browser can't receive the encoder's ${rejected}. Use Chrome or Edge for the studio, or set the encoder to H.264 Baseline.`;
        this._teardown(s, 'rejected');
        this._set(s, 'failed', reason);
        return reply({ type: 'reject', status: 415, reason });
      }
      await waitForIceGathering(pc, 3000);
      if (s.gen !== gen) {
        if (s.whipGen === m.gen) this._set(s, 'waiting', 'The encoder connection was replaced. Waiting for the encoder…');
        return reply({ type: 'reject', status: 409, reason: 'Superseded by a newer connection.' });
      }
      const c = sdpCodecs(pc.localDescription.sdp);
      reply({ type: 'answer', sdp: pc.localDescription.sdp });
      this._set(s, 'connecting', `Encoder offer accepted (video ${c.video || 'none'}, audio ${c.audio || 'none'}). Connecting media…`);
    } catch (e) {
      this._set(s, 'failed', `Could not accept the encoder's offer: ${e.message}`);
      reply({ type: 'reject', status: 400, reason: e.message });
    }
  }

  async _onRelay(m) {
    if (m.from === 'ingest') return this._onIngest(m);
    const match = /^src-(.+)$/.exec(m.from);
    if (!match) return;
    const s = this.list.get(match[1]);
    if (!s) { this._relaySend(m.from, { type: 'unknown-slot' }); return; }
    if (m.type === 'hello') {
      // A contributor only says hello when it needs a (new) connection; it
      // ignores rehello requests while its own connection is healthy.
      s.cfg.mode = 'relay';
      const { pc, gen } = this._newConnection(s);
      this._set(s, 'connecting', 'Contributor is online. Negotiating…');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (s.gen !== gen) return;
      this._relaySend(m.from, { type: 'offer', sdp: pc.localDescription.sdp, gen, name: s.cfg.name, ice: this.ws.settings.ice });
    } else if (m.type === 'answer') {
      if (!s.pc || s.gen !== m.gen || s.pc.signalingState !== 'have-local-offer') return;
      try { await s.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch (e) {
        this._set(s, 'failed', `Contributor's answer was rejected: ${e.message}`);
      }
    } else if (m.type === 'bye') {
      this._teardown(s, 'bye');
      this._set(s, 'ended', 'The contributor ended the stream.');
    }
  }

  // WHEP pull ---------------------------------------------------------------

  async connectWhep(id, token) {
    const s = this.list.get(id);
    if (token !== undefined) s.token = token;
    if (!s.cfg.whepUrl) { this._set(s, 'failed', 'No WHEP URL configured.'); return; }
    const { pc, gen } = this._newConnection(s);
    this._set(s, 'connecting', 'Requesting stream from WHEP endpoint…');
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (s.gen !== gen) return;
      const r = await whepSubscribe({ url: s.cfg.whepUrl, token: s.token, sdp: pc.localDescription.sdp, proxy: this.ws.settings.whipProxy });
      if (s.gen !== gen) { httpTeardown(r.resourceUrl, s.token); return; }
      s.resourceUrl = r.resourceUrl;
      await pc.setRemoteDescription({ type: 'answer', sdp: r.answer });
      const c = sdpCodecs(r.answer);
      this._set(s, 'connecting', `Endpoint answered (video ${c.video || 'none'}, audio ${c.audio || 'none'}). Connecting media…`);
    } catch (e) {
      if (s.gen !== gen) return;
      this._set(s, 'failed', e.message);
      if (e.kind !== 'auth') this._autoRecover(s, e.message);
    }
  }

  // Reconnect: one button, does the right thing per kind.
  async reconnect(id) {
    const s = this.list.get(id);
    if (!s) return null;
    s.retries = 0;
    if (s.cfg.kind === 'whep') return this.connectWhep(id);
    if (s.cfg.kind === 'srt') return this.startSrt(id);
    if (s.cfg.kind === 'obs') {
      s.blocked = false;
      this._teardown(s, 'reconnect');
      this._set(s, 'waiting', 'Waiting for the encoder. Start streaming in OBS (OBS also retries by itself).');
      return null;
    }
    if (s.cfg.mode === 'relay') {
      if (!this.relay) { this._set(s, 'failed', 'Relay signaling is selected for this source but no signaling server is configured.'); return null; }
      this._teardown(s, 'reconnect');
      this._relaySend(`src-${s.id}`, { type: 'rehello' });
      this._set(s, 'waiting', 'Asked the contributor page to reconnect. Waiting…');
      return null;
    }
    return this.createInvite(id);
  }

  _autoRecover(s, why) {
    if (s.cfg.kind === 'srt') {
      this._set(s, s.state, `${why} The helper keeps listening; the SRT sender can reconnect.`);
    } else if (s.cfg.kind === 'obs') {
      this._set(s, s.state, `${why} Waiting for the encoder to reconnect (OBS retries automatically).`);
    } else if (s.cfg.kind === 'whep') {
      clearTimeout(s.retryTimer);
      const delay = Math.min(30, 2 ** Math.min(s.retries, 5)) * 1000;
      s.retries++;
      this._set(s, 'failed', `${why} Retrying in ${delay / 1000}s (attempt ${s.retries}).`);
      s.retryTimer = setTimeout(() => this.connectWhep(s.id), delay);
    } else if (s.cfg.mode === 'relay' && this.relay) {
      this._relaySend(`src-${s.id}`, { type: 'rehello' });
      this._set(s, s.state, `${why} Asked the contributor to reconnect automatically.`);
    } else {
      this._set(s, s.state, `${why} With copy-paste signaling, reconnecting needs a new invite (click Reconnect).`);
    }
  }

  // SRT input through the helper -------------------------------------------

  // The helper's address, set by the app (the one found on this computer, or the relay).
  helper() { return null; }

  async startSrt(id) {
    const s = this.list.get(id);
    if (!s || s.cfg.kind !== 'srt') return null;
    const base = this.helper();
    if (!base || !this.relay) { this._set(s, 'failed', 'SRT input needs the helper running on this computer.'); return null; }
    this.stopSrt(s);
    s.retries = 0;
    this._set(s, 'connecting', `Asking the helper to listen for SRT on port ${s.cfg.srtPort}…`);
    let r, info;
    try {
      r = await fetch(`${base}/srt`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: this.ws.settings.room, slot: s.id, token: s.cfg.token, port: s.cfg.srtPort, latency: s.cfg.srtLatency, passphrase: s.cfg.srtPass || '', kbps: s.cfg.srtKbps, height: this.ws.settings.format.height }) });
      info = await r.json().catch(() => ({}));
    } catch {
      this._set(s, 'failed', `Can't reach the helper at ${base}. Is it running?`);
      return null;
    }
    if (r.status === 404) { this._set(s, 'failed', 'The helper on this computer is too old for SRT. Run Install helper again to update it.'); return null; }
    if (!r.ok) { this._set(s, 'failed', info.error || `The helper refused (HTTP ${r.status}).`); return null; }
    if (!s.cfg.srtOn) this.update(s.id, { srtOn: true });
    s.srt = { url: `${base}/srt/${info.id}`, info };
    s.srt.poll = setInterval(() => this._pollSrt(s), 3000);
    this._srtState(s, info);
    return info;
  }

  async _pollSrt(s) {
    const rt = s.srt;
    if (!rt) return;
    try {
      const r = await fetch(rt.url, { cache: 'no-store' });
      const info = await r.json().catch(() => ({}));
      if (s.srt !== rt) return;
      if (r.status === 404) { this.stopSrt(s); if (s.cfg.srtOn) this.startSrt(s.id); return; } // helper restarted
      rt.info = info;
      this._srtState(s, info);
    } catch {
      if (s.srt === rt && s.state !== 'live') this._set(s, 'failed', "Can't reach the helper. Is it still running?");
    }
  }

  _srtState(s, info) {
    // Runs on every poll: act only when something the card shows changed.
    const key = [info.state, info.port, info.input?.video, info.input?.audio, info.error].join('|');
    if (key === s.srt?.key) return;
    if (s.srt) s.srt.key = key;
    if (s.pc && (s.state === 'live' || s.state === 'connecting' || s.state === 'unstable')) { this.emit('change', s); return; }
    if (info.state === 'error') this._set(s, 'failed', `The helper could not listen on port ${info.port}: ${info.error}`);
    else if (info.state === 'listening') this._set(s, 'waiting', `The helper is listening on port ${info.port}. Start the SRT sender.`);
    else this._set(s, 'connecting', 'SRT sender connected. Converting and connecting…');
  }

  stopSrt(s) {
    if (!s?.srt) return;
    clearInterval(s.srt.poll);
    fetch(s.srt.url, { method: 'DELETE' }).catch(() => {});
    s.srt = null;
  }

  // Data channel to the contributor: tally lights and names.
  _send(s, obj) {
    if (s.dc?.readyState === 'open') { try { s.dc.send(JSON.stringify(obj)); } catch { /* ignore */ } }
  }

  setTally(pgmIds, pvwIds) {
    for (const s of this.list.values()) {
      const t = { pgm: pgmIds.has(s.id), pvw: pvwIds.has(s.id) };
      if (t.pgm !== s.tally.pgm || t.pvw !== s.tally.pvw) { s.tally = t; this._sendTally(s); this.emit('tally', s); }
    }
  }

  _sendTally(s, force) {
    if (!this.ws.settings.sendTally && !force) return;
    if (!this.ws.settings.sendTally) return this._send(s, { type: 'tally', pgm: false, pvw: false });
    this._send(s, { type: 'tally', ...s.tally });
  }

  async _sampleAll() {
    for (const s of this.list.values()) {
      if (!s.sampler) { if (s.stats) { s.stats = null; this.emit('stats', s); } continue; }
      const st = await s.sampler.sample();
      if (st) { s.stats = st; this.emit('stats', s); }
    }
  }
}
