// Incoming WebRTC sources.
//  - "peer": a remote contributor opens contribute.html. Signaling either by
//    copy-paste codes (no infrastructure at all) or via the optional relay.
//  - "whep": pull from any WHEP endpoint (an external WebRTC server/encoder).
//  - "obs", "srt", "rtmp": encoders that publish to the Studio Mixer. They
//            exist only in mixer mode (js/mixer-link.js); the page keeps their
//            settings and shows their state.
// Every source has its own RTCPeerConnection, so one failing never affects
// the others.
import { Emitter, uid, relayWorksRemotely } from './util.js';
import { encodeSignal, decodeSignal } from './codec.js';
import { rtcConfig, waitForIceGathering, StatsSampler, diagnoseFailure, whepSubscribe, httpTeardown, sdpCodecs } from './rtc.js';

// Sources that publish to the Studio Mixer rather than to this page.
export const MIXER_KINDS = new Set(['obs', 'srt', 'rtmp']);

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
  if (s.cfg.kind === 'rtmp' && (s.state === 'waiting' || s.state === 'invited')) return 'Waiting for RTMP sender';
  return SOURCE_STATES[s.state] || s.state;
}

export class SourceManager extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.relay = null;
    this.remote = null; // MixerLink in mixer mode: OBS, SRT and RTMP senders connect to the mixer instead
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
    if (MIXER_KINDS.has(kind)) cfg.mode = 'mixer';
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
        this._set(s, 'live', { whep: 'Receiving from WHEP endpoint.' }[s.cfg.kind] || 'Receiving from contributor.');
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
    this._set(s, 'offline', 'Disconnected by operator.');
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

  async _onRelay(m) {
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
    if (MIXER_KINDS.has(s.cfg.kind)) return null; // senders connect to the mixer
    if (s.cfg.kind === 'whep') return this.connectWhep(id);
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
    if (s.cfg.kind === 'whep') {
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
