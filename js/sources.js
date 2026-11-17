// Incoming WebRTC sources.
//  - "peer": a remote guest opens contribute.html. Signaling through the
//    mailbox (one reusable link that reconnects by itself) or by copy-paste
//    codes (no infrastructure at all).
//  - "whep": pull from any WHEP endpoint (an external WebRTC server/encoder).
//  - "whip": an encoder (OBS, Larix…) publishes to this source's WHIP link on
//    the mailbox, which passes the offer to this page.
//  - "youtube": a video playing in its own small player window.
// Every source has its own RTCPeerConnection, so one failing never affects
// the others.
import { Emitter, uid } from './util.js';
import { encodeSignal, decodeSignal } from './codec.js';
import { parseYouTube, youTubeSupported } from './youtube.js';
import { rtcConfig, waitForIceGathering, StatsSampler, diagnoseFailure, whepSubscribe, httpTeardown, sdpCodecs, iceForPeer } from './rtc.js';
import { MailboxSocket, mailboxBase } from './mailbox.js';

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
  if (s.cfg.kind === 'whip' && s.state === 'waiting') return 'Waiting for encoder';
  if (s.cfg.kind === 'peer' && s.state === 'waiting') return 'Waiting for guest';
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

// Chrome hides this computer's own addresses behind random "….local" names.
// Encoders such as OBS can't resolve those and give up at once, so drop them:
// the browser still reaches the encoder's own addresses, and its public
// address (from STUN) and TURN relays stay in the answer.
function dropMdnsCandidates(sdp) {
  return sdp.split('\r\n').filter((l) => !/^a=candidate:\S+ \d+ \S+ \d+ \S+\.local /i.test(l)).join('\r\n');
}

const WAITING = {
  whip: 'Waiting for the encoder. Paste the WHIP link into it and start streaming.',
  peer: 'Waiting for the guest to open the link.',
};

export class SourceManager extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.list = new Map(); // id -> runtime
    for (const cfg of store.ws.sources) this._makeRuntime(cfg);
    for (const s of this.list.values()) this._mbOpen(s);
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
      mode: kind === 'whip' ? 'whip' : this.mailbox() ? 'mailbox' : 'manual', whepUrl,
    };
    if (kind === 'whip' || kind === 'peer') Object.assign(cfg, { box: uid(12), key: uid(16) });
    if (kind === 'youtube') Object.assign(cfg, { mode: 'youtube', ytUrl: '', ytLoop: false });
    this.ws.sources.push(cfg);
    this.store.save();
    const s = this._makeRuntime(cfg);
    this._mbOpen(s);
    this.emit('added', s);
    this.emit('change', s);
    return s;
  }

  remove(id) {
    const s = this.list.get(id);
    if (!s) return;
    this._teardown(s, 'removed');
    this._mbClose(s);
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
        this._set(s, 'live', { whep: 'Receiving from WHEP endpoint.', whip: 'Receiving from the encoder (WHIP).' }[s.cfg.kind] || 'Receiving from contributor.');
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
    if (s.cfg.kind === 'peer' && s.cfg.mode === 'mailbox') s.mb?.send({ to: 'guest', type: 'bye' });
    this._teardown(s, 'disconnect');
    if (s.cfg.kind === 'youtube') this._ytClose(s);
    if (s.cfg.kind === 'whip') {
      s.blocked = true;
      this._set(s, 'offline', 'Disconnected by operator. The encoder is refused until you click Accept encoder.');
    } else if (s.cfg.kind === 'peer' && s.cfg.mode === 'mailbox') {
      this._set(s, 'offline', 'Disconnected by operator. The guest can join again from their page, or click Reconnect to ask them.');
    } else this._set(s, 'offline', 'Disconnected by operator.');
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
    const code = await encodeSignal({ t: 'offer', role: 'contribute', slot: s.id, name: s.cfg.name, ice: iceForPeer(this.ws.settings.ice), sdp: pc.localDescription.sdp });
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
    if (this.usesMailbox(s)) {
      s.blocked = false;
      this._teardown(s, 'reconnect');
      if (!s.mb || s.mb.state === 'replaced' || s.mb.state === 'closed') this._mbOpen(s);
      if (s.cfg.kind === 'peer') s.mb?.send({ to: 'guest', type: 'rehello' });
      this._mbState(s, s.mb, s.mb?.state);
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
    } else if (s.cfg.kind === 'whip') {
      this._set(s, s.state, `${why} Waiting for the encoder to reconnect (OBS retries by itself).`);
    } else if (s.cfg.kind === 'peer' && s.cfg.mode === 'mailbox') {
      s.mb?.send({ to: 'guest', type: 'rehello' });
      this._set(s, s.state, `${why} Asked the guest's page to reconnect.`);
    } else {
      this._set(s, s.state, `${why} With copy-paste signaling, reconnecting needs a new invite (click Reconnect).`);
    }
  }

  // Mailbox: WHIP links and reusable guest links -----------------------------
  // Each such source keeps a WebSocket open to its own box on the mailbox.

  usesMailbox(s) { return s.cfg.kind === 'whip' || (s.cfg.kind === 'peer' && s.cfg.mode === 'mailbox'); }
  mailbox() { return mailboxBase(this.ws.settings); }

  whipUrl(id) {
    const s = this.list.get(id), base = this.mailbox();
    return s?.cfg.box && base ? `${base}/whip/${s.cfg.box}` : '';
  }

  guestLink(id) {
    const s = this.list.get(id), base = this.mailbox();
    if (!s?.cfg.box || !base) return '';
    const p = new URLSearchParams({ mb: base, box: s.cfg.box, name: s.cfg.name });
    return new URL(`contribute.html#${p}`, location.href).toString();
  }

  /** Reopen every mailbox connection, e.g. after the mailbox address changed. */
  refreshMailbox() { for (const s of this.list.values()) if (!s.pc || this.usesMailbox(s)) this._mbOpen(s); }

  /** Invite links: 'mailbox' (reusable link) or 'manual' (copy-paste codes). */
  setPeerMode(id, mode) {
    const s = this.list.get(id);
    if (!s || s.cfg.kind !== 'peer' || s.cfg.mode === mode) return;
    this.disconnect(id);
    if (!s.cfg.box) Object.assign(s.cfg, { box: uid(12), key: uid(16) });
    this.update(id, { mode });
    this._mbOpen(s);
    if (mode === 'manual') this._set(s, 'offline', 'Click Create invite to send a new invite link.');
  }

  /** A new WHIP or guest link; the old one stops working. */
  newLink(id) {
    const s = this.list.get(id);
    if (!s || !this.usesMailbox(s)) return;
    this._teardown(s, 'new-link');
    this.update(id, { box: uid(12), key: uid(16) });
    this._mbOpen(s);
  }

  _mbOpen(s) {
    this._mbClose(s);
    if (!this.usesMailbox(s)) return;
    const base = this.mailbox();
    if (!base) {
      if (!s.pc) this._set(s, 'offline', 'Needs the mailbox address in Settings → Network.');
      return;
    }
    if (!s.cfg.box) { Object.assign(s.cfg, { box: uid(12), key: uid(16) }); this.store.save(); }
    const mb = new MailboxSocket(base, s.cfg.box, s.cfg.key);
    s.mb = mb;
    mb.on('state', (st) => this._mbState(s, mb, st));
    mb.on('message', (m) => { if (s.mb === mb) this._mbMessage(s, m); });
    this._mbState(s, mb, mb.state);
  }

  _mbClose(s) { s.mb?.close(); s.mb = null; }

  _mbState(s, mb, st) {
    if (!mb || s.mb !== mb) return;
    // A running connection doesn't need the mailbox any more.
    if (s.pc) { this.emit('change', s); return; }
    if (st === 'open') {
      if (s.blocked) this._set(s, 'offline', 'Disconnected by operator. The encoder is refused until you click Accept encoder.');
      else this._set(s, 'waiting', WAITING[s.cfg.kind]);
    } else if (st === 'replaced') {
      this._set(s, 'offline', 'This source is open in another studio tab or window, which receives it now. Click Use it here to take it back.');
    } else if (st === 'closed') {
      this._set(s, 'offline', `Can't reach the mailbox at ${this.mailbox()}. Retrying…`);
    } else {
      this._set(s, 'offline', 'Connecting to the mailbox…');
    }
  }

  _mbMessage(s, m) {
    if (s.cfg.kind === 'whip') { this._onWhip(s, m); return; }
    if (m.from !== 'guest') return;
    if (m.type === 'hello') this._guestHello(s);
    else if (m.type === 'answer') {
      if (!s.pc || s.gen !== m.gen || s.pc.signalingState !== 'have-local-offer') return;
      s.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch((e) => this._set(s, 'failed', `The guest's answer was rejected: ${e.message}`));
    } else if (m.type === 'bye') {
      this._teardown(s, 'bye');
      this._set(s, 'waiting', 'The guest left. They can rejoin with the same link.');
    } else if (m.type === 'guest-left' && s.state !== 'live') {
      this._teardown(s, 'bye');
      this._set(s, 'waiting', 'The guest closed the page. They can rejoin with the same link.');
    }
  }

  async _guestHello(s) {
    const { pc, gen } = this._newConnection(s);
    this._set(s, 'connecting', 'The guest is online. Connecting…');
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc);
      if (s.gen !== gen) return;
      s.mb?.send({ to: 'guest', type: 'offer', sdp: pc.localDescription.sdp, gen, name: s.cfg.name, ice: iceForPeer(this.ws.settings.ice) });
    } catch (e) {
      if (s.gen === gen) this._set(s, 'failed', `Could not prepare the connection: ${e.message}`);
    }
  }

  // WHIP: the encoder's offer arrives through the mailbox; we answer, and media
  // flows from the encoder to this browser.
  async _onWhip(s, m) {
    const reply = (msg) => s.mb?.send({ sid: m.sid, ...msg });
    if (m.type === 'whip-end') {
      if (s.whipSid === m.sid) {
        this._teardown(s, 'bye');
        this._set(s, 'waiting', 'The encoder stopped streaming. Waiting for it to start again.');
      }
      return;
    }
    if (m.type === 'whip-candidate') {
      if (!s.pc || s.whipSid !== m.sid) return;
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
    if (s.blocked) return reply({ type: 'whip-reject', status: 403, reason: 'This source is disconnected in the studio.' });
    const sdp = String(m.sdp || '');
    // Larix and other ice-lite encoders sometimes send an offer without any
    // address; ask them to try again at once.
    if (/^a=ice-lite/m.test(sdp) && !/^a=candidate:/m.test(sdp)) {
      return reply({ type: 'whip-reject', status: 503, retryAfter: 1, reason: 'The offer has no network addresses. Try again.' });
    }
    try {
      const { pc, gen } = this._newConnection(s, { answerer: true });
      s.whipSid = m.sid;
      this._set(s, 'connecting', 'Encoder connected. Negotiating media…');
      await pc.setRemoteDescription({ type: 'offer', sdp });
      for (const t of pc.getTransceivers()) t.direction = 'recvonly';
      const answer = await pc.createAnswer();
      // Let the encoder start the DTLS handshake: Chrome as DTLS client sends a
      // large (post-quantum) hello that OBS's DTLS stack fails on at once.
      answer.sdp = answer.sdp.replace(/^a=setup:active/gm, 'a=setup:passive');
      await pc.setLocalDescription(answer);
      const rejected = rejectedMedia(sdp, pc.localDescription.sdp);
      if (rejected) {
        const reason = `This browser can't receive the encoder's ${rejected}. Use Chrome or Edge for the studio, or set the encoder to H.264 Baseline.`;
        this._teardown(s, 'rejected');
        this._set(s, 'failed', reason);
        return reply({ type: 'whip-reject', status: 415, reason });
      }
      await waitForIceGathering(pc, 3000);
      if (s.gen !== gen) {
        if (s.whipSid === m.sid) this._set(s, 'waiting', 'The encoder connection was replaced. Waiting for the encoder…');
        return reply({ type: 'whip-reject', status: 409, reason: 'Superseded by a newer connection.' });
      }
      const c = sdpCodecs(pc.localDescription.sdp);
      reply({ type: 'whip-answer', sdp: dropMdnsCandidates(pc.localDescription.sdp) });
      this._set(s, 'connecting', `Encoder offer accepted (video ${c.video || 'none'}, audio ${c.audio || 'none'}). Connecting media…`);
    } catch (e) {
      this._set(s, 'failed', `Could not accept the encoder's offer: ${e.message}`);
      reply({ type: 'whip-reject', status: 400, reason: e.message });
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
