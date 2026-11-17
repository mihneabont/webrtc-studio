// Incoming WebRTC sources.
//  - "peer": a remote contributor opens contribute.html. Signaling by
//    copy-paste codes (no infrastructure at all).
//  - "whep": pull from any WHEP endpoint (an external WebRTC server/encoder).
//  - "youtube": a video playing in its own small player window.
// Every source has its own RTCPeerConnection, so one failing never affects
// the others.
import { Emitter, uid } from './util.js';
import { encodeSignal, decodeSignal } from './codec.js';
import { parseYouTube, youTubeSupported } from './youtube.js';
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
  if (s.cfg.kind === 'youtube' && (s.state === 'waiting' || s.state === 'invited')) return 'Waiting for player';
  return SOURCE_STATES[s.state] || s.state;
}

export class SourceManager extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.list = new Map(); // id -> runtime
    for (const cfg of store.ws.sources) this._makeRuntime(cfg);
    this._statsTimer = setInterval(() => this._sampleAll(), 1000);
    window.addEventListener('pagehide', () => {
      for (const s of this.list.values()) if (s.resourceUrl) httpTeardown(s.resourceUrl, s.token, { keepalive: true });
    });
    // YouTube sources: each player window (youtube.html) hands over its captured
    // stream through this function, and reports playback with postMessage.
    window.__studioYouTubeStream = (sid, stream) => this._ytStream(sid, stream);
    window.addEventListener('message', (e) => {
      if (e.origin === location.origin && e.data?.type === 'yt-status') this._ytStatus(e.data.sid, e.data);
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

  add({ name, kind = 'peer', whepUrl = '' }) {
    const cfg = {
      id: uid(4), name: name || `Source ${this.ws.sources.length + 1}`, kind,
      mode: 'manual', whepUrl,
    };
    if (kind === 'youtube') Object.assign(cfg, { mode: 'youtube', ytUrl: '', ytLoop: false });
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
    if (s.cfg.kind === 'youtube') this._ytClose(s);
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

  _newConnection(s) {
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
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

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
        this._set(s, 'live', s.cfg.kind === 'whep' ? 'Receiving from WHEP endpoint.' : 'Receiving from contributor.');
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
      if (m.type === 'media') { s.paused = { video: m.video === false, audio: m.audio === false }; this.emit('change', s); } // camera or mic turned off by the contributor
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
    this._teardown(s, 'disconnect');
    if (s.cfg.kind === 'youtube') this._ytClose(s);
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
      const r = await whepSubscribe({ url: s.cfg.whepUrl, token: s.token, sdp: pc.localDescription.sdp });
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
    if (s.cfg.kind === 'youtube') return this.connectYouTube(id);
    return this.createInvite(id);
  }

  _autoRecover(s, why) {
    if (s.cfg.kind === 'whep') {
      clearTimeout(s.retryTimer);
      const delay = Math.min(30, 2 ** Math.min(s.retries, 5)) * 1000;
      s.retries++;
      this._set(s, 'failed', `${why} Retrying in ${delay / 1000}s (attempt ${s.retries}).`);
      s.retryTimer = setTimeout(() => this.connectWhep(s.id), delay);
    } else {
      this._set(s, s.state, `${why} With copy-paste signaling, reconnecting needs a new invite (click Reconnect).`);
    }
  }

  // YouTube ------------------------------------------------------------------
  // Each video plays in YouTube's own player in its own small window
  // (youtube.html). After one click on Start there, that window captures only
  // its player, with its own sound, and hands the stream over. Nothing is
  // downloaded, and each YouTube source has its own fader like any other.

  /** Open (or reopen) the source's player window. Call from a click: browsers block pop-ups otherwise. */
  connectYouTube(id, url) {
    const s = this.list.get(id);
    if (!s || s.cfg.kind !== 'youtube') return null;
    if (url !== undefined) this.update(id, { ytUrl: url.trim() });
    const v = parseYouTube(s.cfg.ytUrl);
    if (!v) { this._set(s, 'failed', 'That isn\'t a YouTube video link. Paste a link like https://www.youtube.com/watch?v=… or https://youtu.be/…'); return null; }
    if (!youTubeSupported()) { this._set(s, 'failed', 'YouTube sources aren\'t available in this browser. Use a current Chrome or Edge (version 132 or later).'); return null; }
    const p = new URLSearchParams({ sid: s.id, v: v.id, t: String(v.start), name: s.cfg.name, loop: s.cfg.ytLoop ? '1' : '0' });
    // Its size is the captured size: as close to the programme as the screen allows.
    const f = this.ws.settings.format || { width: 1920, height: 1080 };
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(Math.min(f.width / dpr, screen.availWidth * 0.9)), h = Math.round(w * 9 / 16);
    const win = window.open(new URL(`youtube.html#${p}`, location.href).toString(), `studio-yt-${s.id}`, `popup,width=${w},height=${h}`);
    if (!win) { this._set(s, 'failed', 'The browser blocked the YouTube window. Allow pop-ups for this page, then click Connect again.'); return null; }
    this._teardown(s, 'reconnect');
    s.yt = { win, status: null, videoId: v.id };
    this._set(s, 'waiting', 'In the YouTube window that opened, click Start and choose Allow.');
    return win;
  }

  ytCommand(id, cmd, arg) {
    const s = this.list.get(id);
    if (cmd === 'loop') this.update(id, { ytLoop: !!arg });
    try { s?.yt?.win?.postMessage({ type: 'yt-cmd', sid: id, cmd, arg }, location.origin); } catch { /* window closed */ }
  }

  /** Bring the source's YouTube window to the front (to click Start, for example). */
  ytShow(id) { try { this.list.get(id)?.yt?.win?.focus(); } catch { /* closed */ } }

  _ytStream(sid, stream) {
    const s = this.list.get(sid);
    if (!s || s.cfg.kind !== 'youtube') { for (const t of stream.getTracks()) t.stop(); return; }
    if (s.stream) for (const t of s.stream.getTracks()) t.stop();
    s.gen++;
    const gen = s.gen;
    s.stream = stream;
    s.hasVideo = stream.getVideoTracks().length > 0;
    s.hasAudio = stream.getAudioTracks().length > 0;
    s.videoFlowing = s.hasVideo; s.audioFlowing = s.hasAudio;
    for (const t of stream.getTracks()) {
      t.addEventListener('ended', () => {
        if (s.gen !== gen) return;
        s.stream = null; s.hasVideo = s.hasAudio = s.videoFlowing = s.audioFlowing = false;
        this.emit('media', s);
        this._set(s, 'ended', 'The YouTube window stopped sharing. Click Start in it again, or Connect.');
      });
    }
    this.emit('media', s);
    this._set(s, 'live', s.hasAudio ? 'YouTube video ready. Play it from here; its sound goes to the programme only.' : 'YouTube video ready, without sound (the window\'s audio wasn\'t shared).');
  }

  _ytStatus(id, st) {
    const s = this.list.get(id);
    if (!s || s.cfg.kind !== 'youtube') return;
    if (st.error) { this._set(s, 'failed', st.error); return; }
    if (!s.yt) s.yt = { win: null, status: null };
    const before = s.yt.status;
    s.yt.status = st;
    if (!before || before.state !== st.state || before.title !== st.title || before.loop !== st.loop || before.muted !== st.muted || before.captured !== st.captured || !before.duration !== !st.duration) this.emit('change', s);
    this.emit('yt', s);
  }

  _ytClose(s) {
    try { s.yt?.win?.close(); } catch { /* already closed */ }
    s.yt = null;
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
