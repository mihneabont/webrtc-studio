// Preview / Programme bus, transitions, fade-to-black and graphics keys.
// The compositor asks for a render plan every frame; nothing here touches
// media directly, so switching never renegotiates or interrupts an output.
import { Emitter, clamp } from './util.js';
import { shotEq } from './scenes.js';

const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

export const TRANSITIONS = { mix: 'Mix', dip: 'Dip to black', wipe: 'Wipe', push: 'Push' };

export class Switcher extends Emitter {
  constructor(store, scenes, audio) {
    super();
    this.store = store;
    this.scenes = scenes;
    this.audio = audio;
    this.preview = store.ws.shots.preview;
    this.programme = store.ws.shots.programme;
    this.trans = null; // {from, to, type, dur, start, manual, pos}
    this.ftb = { black: false, v: 0, from: 0, to: 0, start: 0, dur: 0 };
    this.keys = new Map(); // overlay id -> {on, v, from, to, start, dur}
    this._syncAudio(0);
  }

  get ws() { return this.store.ws; }
  get tset() { return this.ws.transition; }
  get inTransition() { return !!this.trans; }

  _persist() {
    this.ws.shots = { preview: this.preview, programme: this.programme };
    this.store.save();
  }

  setPreview(shot) {
    if (shotEq(shot, this.preview)) return;
    this.preview = shot;
    this._persist();
    this.emit('change');
  }

  _syncAudio(rampSecs, shot = this.programme) {
    this.audio?.setAudible(this.scenes.sourcesIn(shot), rampSecs);
  }

  cut() {
    if (this.trans) return this._complete();
    if (!this.preview) return;
    const old = this.programme;
    this.programme = this.preview;
    if (this.ws.settings.swapOnTake && old) this.preview = old;
    this._syncAudio(0.03);
    this._persist();
    this.emit('change');
    this.emit('take', { type: 'cut' });
  }

  auto() {
    if (this.trans) return; // already running
    if (!this.preview) return;
    if (shotEq(this.preview, this.programme) && this.tset.type !== 'dip') return this.cut();
    this.trans = { from: this.programme, to: this.preview, type: this.tset.type, dur: this.tset.duration, start: performance.now(), manual: false, pos: 0 };
    this._syncAudio(this.tset.duration / 1000, this.preview);
    this.emit('change');
  }

  // Manual T-bar: pos 0..1. Reaching 1 completes the take.
  tbar(pos) {
    pos = clamp(pos, 0, 1);
    if (!this.trans) {
      if (pos <= 0 || !this.preview) return;
      this.trans = { from: this.programme, to: this.preview, type: this.tset.type, dur: 0, start: 0, manual: true, pos };
      this._syncAudio(0.5, this.preview);
      this.emit('change');
    }
    if (!this.trans.manual) return;
    this.trans.pos = pos;
    if (pos >= 1) this._complete();
    else if (pos <= 0) { this.trans = null; this._syncAudio(0.2); this.emit('change'); }
  }

  _complete() {
    const t = this.trans;
    this.trans = null;
    if (!t) return;
    this.programme = t.to;
    if (this.ws.settings.swapOnTake && t.from) this.preview = t.from;
    this._syncAudio(0.05);
    this._persist();
    this.emit('change');
    this.emit('take', { type: t.type });
  }

  toggleFtb() {
    const now = performance.now();
    const black = !this.ftb.black;
    const dur = Math.max(1, this.tset.duration);
    this.ftb = { black, v: this.ftb.v, from: this.ftb.v, to: black ? 1 : 0, start: now, dur };
    this.audio?.setFtb(black, dur / 1000);
    this.emit('change');
  }

  setKey(id, on, durMs = 500) {
    const k = this.keys.get(id) || { on: false, v: 0 };
    if (k.on === on) return;
    this.keys.set(id, { on, v: k.v, from: k.v, to: on ? 1 : 0, start: performance.now(), dur: durMs });
    this.emit('change');
  }
  keyOn(id) { return !!this.keys.get(id)?.on; }

  // Called by the compositor once per programme frame.
  plan(now = performance.now()) {
    let p = 0;
    if (this.trans) {
      p = this.trans.manual ? this.trans.pos : (now - this.trans.start) / Math.max(1, this.trans.dur);
      if (!this.trans.manual && p >= 1) { this._complete(); p = 0; }
    }
    const f = this.ftb;
    if (f.v !== f.to) {
      const q = clamp((now - f.start) / f.dur, 0, 1);
      f.v = f.from + (f.to - f.from) * q;
      if (q >= 1) { f.v = f.to; this.emit('change'); }
    }
    const overlays = [];
    for (const ov of this.ws.overlays) {
      const k = this.keys.get(ov.id);
      if (!k) continue;
      if (k.v !== k.to) {
        const q = clamp((now - k.start) / Math.max(1, k.dur), 0, 1);
        k.v = k.from + (k.to - k.from) * q;
      }
      if (k.v > 0) overlays.push({ ov, v: k.v });
    }
    return {
      a: this.scenes.resolve(this.trans ? this.trans.from : this.programme),
      b: this.trans ? this.scenes.resolve(this.trans.to) : null,
      p: this.trans ? (this.trans.manual ? p : ease(clamp(p, 0, 1))) : 0,
      type: this.trans?.type,
      ftb: f.v,
      overlays,
    };
  }

  // Shots whose sources are currently in programme (tally).
  pgmSources() {
    const ids = this.scenes.sourcesIn(this.programme);
    if (this.trans) for (const id of this.scenes.sourcesIn(this.trans.to)) ids.add(id);
    return ids;
  }
  pvwSources() { return this.scenes.sourcesIn(this.preview); }
}
