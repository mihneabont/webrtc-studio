// Programme audio mixer built on the Web Audio API.
//
//   source track ─► fader ─► mute ─┬─► PGM gate (on / off / audio-follows-video) ─► bus
//                                  ├─► PFL gate ─► monitor
//                                  └─► meter
//   bus ─► master ─► FTB fade ─┬─► MediaStreamDestination  (the programme audio track)
//                              ├─► meters
//                              └─► monitor (off by default) ─► speakers
//
// Source audio only ever enters through this graph (all media elements stay
// muted), so nothing is routed twice. Local monitoring is opt-in, which avoids
// feedback if the studio machine also has an open microphone nearby.
import { Emitter, dbToGain } from './util.js';

export class AudioMixer extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    const c = this.ctx;
    this.bus = c.createGain();
    this.master = c.createGain();
    this.ftb = c.createGain();
    this.dest = c.createMediaStreamDestination();
    this.dest.channelCount = 2;
    this.splitter = c.createChannelSplitter(2);
    this.meterL = this._analyser();
    this.meterR = this._analyser();
    this.pgmToMon = c.createGain();
    this.pflBus = c.createGain();
    this.monitor = c.createGain();

    this.bus.connect(this.master).connect(this.ftb);
    this.ftb.connect(this.dest);
    this.ftb.connect(this.splitter);
    this.splitter.connect(this.meterL, 0);
    this.splitter.connect(this.meterR, 1);
    this.ftb.connect(this.pgmToMon).connect(this.monitor);
    this.pflBus.connect(this.monitor);
    this.monitor.connect(c.destination);

    this.channels = new Map();
    this.audible = new Set();
    this._buf = new Float32Array(2048);
    this.applyMaster();
    this.applyMonitor();

    c.onstatechange = () => this.emit('state', c.state);
    const resume = () => { if (c.state !== 'running') c.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, { capture: true });
  }

  get cfg() { return this.store.ws.audio; }
  get outputTrack() { return this.dest.stream.getAudioTracks()[0]; }

  _analyser() {
    const a = this.ctx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0;
    return a;
  }

  chCfg(id) {
    if (!this.cfg.channels[id]) this.cfg.channels[id] = { db: 0, muted: false, mode: 'afv', pfl: false };
    return this.cfg.channels[id];
  }

  _ensure(id) {
    let ch = this.channels.get(id);
    if (ch) return ch;
    const c = this.ctx;
    ch = { id, src: null, track: null, fader: c.createGain(), mute: c.createGain(), pgm: c.createGain(), pfl: c.createGain(), meter: this._analyser() };
    ch.fader.connect(ch.mute);
    ch.mute.connect(ch.pgm).connect(this.bus);
    ch.mute.connect(ch.pfl).connect(this.pflBus);
    ch.mute.connect(ch.meter);
    ch.pgm.gain.value = 0;
    this.channels.set(id, ch);
    this.applyChannel(id, 0);
    return ch;
  }

  // Bind (or re-bind after reconnect) a source's stream to its channel.
  attach(id, stream) {
    const ch = this._ensure(id);
    const track = stream?.getAudioTracks()[0] || null;
    if (track === ch.track) return;
    if (ch.src) { try { ch.src.disconnect(); } catch { /* ignore */ } ch.src = null; }
    ch.track = track;
    if (track) {
      ch.src = this.ctx.createMediaStreamSource(new MediaStream([track]));
      ch.src.connect(ch.fader);
    }
    this.emit('change');
  }

  remove(id) {
    const ch = this.channels.get(id);
    if (!ch) return;
    for (const n of [ch.src, ch.fader, ch.mute, ch.pgm, ch.pfl, ch.meter]) { try { n?.disconnect(); } catch { /* ignore */ } }
    this.channels.delete(id);
  }

  hasAudio(id) { return !!this.channels.get(id)?.track; }

  _ramp(param, value, secs) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + Math.max(0.02, secs));
  }

  applyChannel(id, ramp = 0.05) {
    const ch = this._ensure(id);
    const cfg = this.chCfg(id);
    this._ramp(ch.fader.gain, dbToGain(cfg.db), 0.03);
    this._ramp(ch.mute.gain, cfg.muted ? 0 : 1, 0.03);
    const on = cfg.mode === 'on' || (cfg.mode === 'afv' && this.audible.has(id));
    this._ramp(ch.pgm.gain, on ? 1 : 0, ramp);
    this._ramp(ch.pfl.gain, cfg.pfl ? 1 : 0, 0.03);
    this.applyMonitor();
  }

  set(id, patch) {
    Object.assign(this.chCfg(id), patch);
    this.store.save();
    this.applyChannel(id);
    this.emit('change');
  }

  // Called by the switcher whenever the programme changes: sources visible in
  // programme become audible for channels in audio-follows-video mode.
  setAudible(ids, rampSecs) {
    this.audible = new Set(ids);
    for (const id of this.channels.keys()) this.applyChannel(id, rampSecs);
  }

  isOnAir(id) {
    const cfg = this.chCfg(id);
    return !cfg.muted && (cfg.mode === 'on' || (cfg.mode === 'afv' && this.audible.has(id)));
  }

  applyMaster() { this._ramp(this.master.gain, dbToGain(this.cfg.masterDb), 0.03); }

  applyMonitor() {
    const on = this.cfg.monitor === 'on';
    const anyPfl = Object.values(this.cfg.channels).some((c) => c.pfl);
    this._ramp(this.monitor.gain, on ? dbToGain(this.cfg.monitorDb) : 0, 0.03);
    this._ramp(this.pgmToMon.gain, anyPfl ? 0 : 1, 0.03);
  }

  setFtb(black, secs) {
    this._ramp(this.ftb.gain, black && this.cfg.ftbAudio ? 0 : 1, secs);
  }

  _level(an) {
    an.getFloatTimeDomainData(this._buf);
    let peak = 0;
    for (let i = 0; i < this._buf.length; i++) { const v = Math.abs(this._buf[i]); if (v > peak) peak = v; }
    return peak <= 0.00001 ? -100 : 20 * Math.log10(peak);
  }

  levels() {
    const out = { master: [this._level(this.meterL), this._level(this.meterR)], ch: {} };
    for (const [id, ch] of this.channels) out.ch[id] = ch.track ? this._level(ch.meter) : null;
    return out;
  }
}
