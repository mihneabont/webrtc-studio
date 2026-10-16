// Programme outputs. Every output is its own RTCPeerConnection sending the
// same two tracks (composited video + mixed audio), so outputs start, fail
// and reconnect independently, and switching never touches them.
//  - "peer":   a remote receiver opens receive.html (copy-paste codes or relay)
//  - "whip":   any WHIP (RFC 9725) ingest endpoint
//  - "twitch": WHIP with Twitch-specific settings (H.264 + Opus, bitrate caps)
import { Emitter, uid } from './util.js';
import { encodeSignal, decodeSignal } from './codec.js';
import { rtcConfig, waitForIceGathering, StatsSampler, diagnoseFailure, whipPublish, httpTeardown, preferCodec, codecSupported, sdpCodecs, HttpSignalError } from './rtc.js';

export const TWITCH = {
  // Undocumented by Twitch's official docs as of 2026-10: this is the endpoint
  // Twitch announced for WHIP/WebRTC ingest in 2023 and that OBS uses.
  url: 'https://g.webrtc.live-video.net:4443/v2/offer',
  defaultKbps: 6000,
  maxKbps: 8500,
  maxWidth: 1920, maxHeight: 1080, maxFps: 60,
};

export const OUTPUT_STATES = {
  idle: 'Stopped', preparing: 'Preparing', invited: 'Waiting for receiver', waiting: 'Waiting for receiver',
  connecting: 'Connecting', live: 'Live', unstable: 'Unstable', failed: 'Failed', stopped: 'Stopped',
};

export function defaultKbps(height) {
  return height >= 1080 ? 6000 : height >= 720 ? 3500 : 1500;
}

export class OutputManager extends Emitter {
  constructor(store, compositor, audio) {
    super();
    this.store = store;
    this.compositor = compositor;
    this.audio = audio;
    this.relay = null;
    this.list = new Map();
    for (const cfg of store.ws.outputs) this._makeRuntime(cfg);
    this._timer = setInterval(() => this._sampleAll(), 1000);
    window.addEventListener('pagehide', () => {
      for (const o of this.list.values()) if (o.resourceUrl) httpTeardown(o.resourceUrl, o.token, { keepalive: true });
    });
  }

  get ws() { return this.store.ws; }
  get stream() { return new MediaStream([this.compositor.track, this.audio.outputTrack]); }
  get(id) { return this.list.get(id); }
  all() { return this.ws.outputs.map((c) => this.list.get(c.id)).filter(Boolean); }
  liveCount() { return this.all().filter((o) => o.state === 'live').length; }

  _makeRuntime(cfg) {
    const o = { cfg, id: cfg.id, state: 'idle', detail: 'Saved configuration. Not started in this session.', pc: null, gen: 0, sampler: null, stats: null, invite: null, resourceUrl: null, token: '', retries: 0, retryTimer: null, startedAt: null, negotiated: null };
    this.list.set(cfg.id, o);
    return o;
  }

  add({ kind = 'peer', name, url = '' }) {
    const h = this.ws.settings.format.height;
    const cfg = {
      id: uid(4), kind, name: name || (kind === 'twitch' ? 'Twitch' : kind === 'whip' ? 'WHIP output' : `Receiver ${this.ws.outputs.length + 1}`),
      mode: this.ws.settings.signalingUrl ? 'relay' : 'manual',
      url: kind === 'twitch' ? TWITCH.url : url,
      maxKbps: kind === 'twitch' ? Math.min(TWITCH.defaultKbps, defaultKbps(h)) : defaultKbps(h),
      codec: kind === 'twitch' ? 'h264' : 'auto',
      autoReconnect: kind !== 'peer',
      remember: 'none',
    };
    this.ws.outputs.push(cfg);
    this.store.save();
    const o = this._makeRuntime(cfg);
    this.emit('change', o);
    return o;
  }

  remove(id) {
    const o = this.list.get(id);
    if (!o) return;
    this.stop(id, true);
    this.list.delete(id);
    this.ws.outputs = this.ws.outputs.filter((c) => c.id !== id);
    this.store.save();
    this.emit('removed', id);
  }

  update(id, patch) {
    const o = this.list.get(id);
    Object.assign(o.cfg, patch);
    this.store.save();
    if ('maxKbps' in patch) this.applyEncoding(o);
    this.emit('change', o);
  }

  _set(o, state, detail) {
    o.state = state;
    if (detail !== undefined) o.detail = detail;
    if (state === 'live') o.retries = 0;
    this.emit('change', o);
  }

  // Twitch-specific validation of the programme format.
  formatProblems(o) {
    const f = this.ws.settings.format;
    const p = [];
    if (o.cfg.kind === 'twitch') {
      if (f.width > TWITCH.maxWidth || f.height > TWITCH.maxHeight) p.push(`Twitch accepts at most ${TWITCH.maxWidth}×${TWITCH.maxHeight}.`);
      if (f.fps > TWITCH.maxFps) p.push(`Twitch accepts at most ${TWITCH.maxFps} fps.`);
      if (o.cfg.maxKbps > TWITCH.maxKbps) p.push(`Twitch rejects or drops streams above about ${TWITCH.maxKbps} kb/s.`);
      if (!codecSupported('video', 'video/H264')) p.push('This browser cannot encode H.264, which Twitch requires.');
    }
    return p;
  }

  _newPc(o) {
    this._close(o);
    o.gen++;
    const gen = o.gen;
    const ice = this.ws.settings.ice;
    const pc = new RTCPeerConnection(rtcConfig(ice));
    o.pc = pc;
    o.sampler = new StatsSampler(pc);
    o.stats = null;
    const stream = this.stream;
    const fps = this.ws.settings.format.fps;
    const vt = pc.addTransceiver(this.compositor.track, {
      direction: 'sendonly', streams: [stream],
      sendEncodings: [{ maxBitrate: o.cfg.maxKbps * 1000, maxFramerate: fps }],
    });
    const at = pc.addTransceiver(this.audio.outputTrack, { direction: 'sendonly', streams: [stream], sendEncodings: [{ maxBitrate: 128000 }] });
    const want = o.cfg.codec === 'auto' ? null : `video/${o.cfg.codec.toUpperCase()}`;
    if (want && !preferCodec(vt, want, { only: o.cfg.kind === 'twitch' })) {
      throw new Error(`This browser cannot send ${o.cfg.codec.toUpperCase()} video${o.cfg.kind === 'twitch' ? ', which Twitch requires' : ''}.`);
    }
    preferCodec(at, 'audio/opus');
    o.video = vt.sender;
    this.applyEncoding(o);

    pc.onconnectionstatechange = async () => {
      if (o.gen !== gen) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        o.startedAt = o.startedAt || Date.now();
        o.wasLive = true;
        this._set(o, 'live', o.cfg.kind === 'peer' ? 'Sending programme to receiver.' : 'Broadcasting programme to the ingest endpoint.');
      } else if (st === 'disconnected') {
        this._set(o, 'unstable', 'Connection interrupted. Trying to recover…');
        setTimeout(() => { if (o.gen === gen && pc.connectionState === 'disconnected') this._retry(o, 'Connection did not recover.'); }, 8000);
      } else if (st === 'failed') {
        const why = await diagnoseFailure(pc, rtcConfig(ice).iceServers);
        if (o.gen !== gen) return;
        this._retry(o, `Connection failed. ${why}`);
      }
    };
    return { pc, gen };
  }

  async applyEncoding(o) {
    const s = o.video;
    if (!s) return;
    try {
      const p = s.getParameters();
      if (!p.encodings?.length) return;
      p.encodings[0].maxBitrate = o.cfg.maxKbps * 1000;
      p.encodings[0].maxFramerate = this.ws.settings.format.fps;
      // Ingest platforms dislike resolution changes mid-stream; peers can adapt.
      p.degradationPreference = o.cfg.kind === 'peer' ? 'balanced' : 'maintain-resolution';
      await s.setParameters(p);
    } catch (e) {
      console.warn('setParameters failed', e);
    }
  }

  applyEncodingAll() { for (const o of this.list.values()) this.applyEncoding(o); }

  async start(id, { token, passphrase } = {}) {
    const o = this.list.get(id);
    if (!o) return null;
    clearTimeout(o.retryTimer);
    o.startedAt = null;
    if (token !== undefined) o.token = token;
    try {
      if (o.cfg.kind === 'peer') {
        if (o.cfg.mode === 'relay') {
          if (!this.relay) throw new Error('Relay signaling is selected but no signaling server is configured.');
          this._close(o);
          this._set(o, 'waiting', 'Open the receiver link on the receiving device. It connects automatically.');
          this.relay.send(`out-${o.id}`, { type: 'rehello' }).catch(() => {});
          return null;
        }
        return await this._invite(o);
      }
      return await this._whip(o);
    } catch (e) {
      this._close(o);
      // Retry only what can heal by itself: server overload, or a network
      // error while reconnecting an output that was already live.
      const retryable = e instanceof HttpSignalError && o.cfg.kind !== 'peer' && o.cfg.autoReconnect &&
        (e.status >= 500 || e.status === 429 || (e.kind === 'network' && o.wasLive));
      if (retryable) this._retry(o, e.message);
      else this._set(o, 'failed', e.message);
      return null;
    }
  }

  async _invite(o) {
    const { pc, gen } = this._newPc(o);
    this._set(o, 'preparing', 'Preparing invite (gathering network addresses)…');
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc);
    if (o.gen !== gen) return null;
    const code = await encodeSignal({ t: 'offer', role: 'receive', out: o.id, name: o.cfg.name, ice: this.ws.settings.ice, sdp: pc.localDescription.sdp });
    o.invite = { code, link: new URL(`receive.html#c=${code}`, location.href).toString() };
    this._set(o, 'invited', 'Open the receiver link on the receiving device, then paste its reply code here.');
    return o.invite;
  }

  async acceptAnswer(id, text) {
    const o = this.list.get(id);
    if (!o?.pc || o.pc.signalingState !== 'have-local-offer') throw new Error('No pending invite for this output. Start it first.');
    const msg = await decodeSignal(text);
    if (msg.t !== 'answer') throw new Error('That is not a reply code from a receiver page.');
    if (msg.out && msg.out !== o.id) throw new Error('That reply belongs to a different output.');
    await o.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    o.negotiated = sdpCodecs(msg.sdp);
    o.invite = null;
    this._set(o, 'connecting', 'Reply accepted. Connecting…');
  }

  async _whip(o) {
    const probs = this.formatProblems(o);
    if (probs.length) throw new Error(probs.join(' '));
    if (!o.cfg.url) throw new Error('Enter the WHIP endpoint URL.');
    if (o.cfg.kind === 'twitch' && !o.token) throw new Error('Enter your Twitch stream key.');
    const { pc, gen } = this._newPc(o);
    this._set(o, 'preparing', 'Creating offer…');
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc, 3000);
    if (o.gen !== gen) return null;
    this._set(o, 'connecting', `Sending offer to ${new URL(o.cfg.url).host}…`);
    const r = await whipPublish({ url: o.cfg.url, token: o.token, sdp: pc.localDescription.sdp, proxy: this.ws.settings.whipProxy });
    if (o.gen !== gen) { httpTeardown(r.resourceUrl, o.token); return null; }
    o.resourceUrl = r.resourceUrl;
    o.negotiated = sdpCodecs(r.answer);
    await pc.setRemoteDescription({ type: 'answer', sdp: r.answer });
    this._set(o, 'connecting', `Endpoint accepted the offer (video ${o.negotiated.video || 'none'}, audio ${o.negotiated.audio || 'none'})${r.resourceUrl ? '' : ', but returned no session URL, so Stop cannot notify it'}. Connecting media…`);
    return null;
  }

  _retry(o, why) {
    if (o.cfg.kind !== 'peer' && o.cfg.autoReconnect) {
      const delay = Math.min(30, 2 ** Math.min(o.retries, 5)) * 1000;
      o.retries++;
      this._close(o);
      this._set(o, 'failed', `${why} Reconnecting in ${delay / 1000}s (attempt ${o.retries}).`);
      o.retryTimer = setTimeout(() => this.start(o.id), delay);
    } else if (o.cfg.kind === 'peer' && o.cfg.mode === 'relay' && this.relay) {
      this._set(o, 'failed', `${why} Asked the receiver to reconnect.`);
      this.relay.send(`out-${o.id}`, { type: 'rehello' }).catch(() => {});
    } else {
      this._set(o, 'failed', `${why} Click Reconnect.`);
    }
  }

  _close(o) {
    clearTimeout(o.retryTimer);
    if (o.resourceUrl) { httpTeardown(o.resourceUrl, o.token); o.resourceUrl = null; }
    if (o.pc) { try { o.pc.close(); } catch { /* ignore */ } }
    o.pc = null; o.sampler = null; o.video = null; o.invite = null;
    o.gen++;
  }

  stop(id, silent) {
    const o = this.list.get(id);
    if (!o) return;
    o.wasLive = false;
    o.retries = 0;
    if (o.cfg.kind === 'peer' && o.cfg.mode === 'relay') this.relay?.send(`out-${o.id}`, { type: 'bye' }).catch(() => {});
    this._close(o);
    o.stats = null;
    if (!silent) this._set(o, 'stopped', 'Stopped by operator.');
  }

  // Optional relay ---------------------------------------------------------
  attachRelay(relay) {
    this.relay = relay;
    relay?.on('message', (m) => this._onRelay(m));
  }

  relayLink(id) {
    const st = this.ws.settings;
    const p = new URLSearchParams({ sig: st.signalingUrl, room: st.room, out: id });
    return new URL(`receive.html#${p}`, location.href).toString();
  }

  async _onRelay(m) {
    const match = /^out-(.+)$/.exec(m.from);
    if (!match) return;
    const o = this.list.get(match[1]);
    if (!o) return;
    if (m.type === 'hello') {
      if (o.state === 'idle' || o.state === 'stopped') {
        this.relay.send(m.from, { type: 'not-started' }).catch(() => {});
        return;
      }
      try {
        const { pc, gen } = this._newPc(o);
        this._set(o, 'connecting', 'Receiver is online. Negotiating…');
        await pc.setLocalDescription(await pc.createOffer());
        await waitForIceGathering(pc);
        if (o.gen !== gen) return;
        await this.relay.send(m.from, { type: 'offer', sdp: pc.localDescription.sdp, gen, name: o.cfg.name, ice: this.ws.settings.ice });
      } catch (e) {
        this._set(o, 'failed', e.message);
      }
    } else if (m.type === 'answer') {
      if (!o.pc || o.gen !== m.gen || o.pc.signalingState !== 'have-local-offer') return;
      o.negotiated = sdpCodecs(m.sdp);
      await o.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch((e) => this._set(o, 'failed', e.message));
    } else if (m.type === 'bye') {
      this._close(o);
      this._set(o, 'waiting', 'Receiver left. Waiting for it to come back…');
    }
  }

  async _sampleAll() {
    for (const o of this.list.values()) {
      if (!o.sampler) continue;
      const st = await o.sampler.sample();
      if (st) { o.stats = st; this.emit('stats', o); }
    }
  }
}
