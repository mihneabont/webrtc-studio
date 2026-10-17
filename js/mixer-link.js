// Mixer mode: the studio page as the control room of a Studio Mixer.
//
// The mixer (mixer/ in this repository) does the mixing, encoding, SRT/RTMP
// ingest and outputs. This page keeps its screens and sends the mixer:
//   - the workspace (sources, scenes, keys, audio, transition, outputs),
//   - commands (preview, cut, auto, T-bar, fade to black, keys, outputs),
//   - graphics: everything in a scene that is not live video (backgrounds,
//     text, shapes, images, borders, labels) and every key, drawn here with
//     the compositor's own drawing code into PNGs, so graphics look the same
//     as in browser mode,
//   - cameras and contributors that reach this page, forwarded over WHIP.
// It gets back one light "multiview" stream (Preview, Programme and source
// tiles in a single 720p picture) and cuts it up into its monitors, plus
// status and audio meters. Full-quality video stays on the mixer.
import { Emitter, uid } from './util.js';
import { whipPublish, whepSubscribe, httpTeardown, preferCodec } from './rtc.js';
import { shotEq } from './scenes.js';
import { defaultKbps } from './outputs.js';

const FONT = '"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MIXER_KINDS = new Set(['obs', 'srt', 'rtmp']); // sources that publish straight to the mixer
const OUTPUT_KINDS = new Set(['rtmp', 'twitch', 'whip', 'srt']); // outputs the mixer sends

export function shotId(shot) {
  if (!shot) return null;
  return shot.kind === 'source' ? `src:${shot.id}` : shot.id;
}
export function shotFrom(id) {
  if (!id) return null;
  return id.startsWith('src:') ? { kind: 'source', id: id.slice(4) } : { kind: 'scene', id };
}

// The show lives on the mixer, so every browser connected to it opens the same sources, scenes,
// graphics and outputs. Connection settings, this page's layout and stream keys stay per browser.
const SHOW_SETTINGS = ['format', 'mixerKbps', 'swapOnTake', 'defaultFit'];
export function showOf(ws) {
  return {
    sources: ws.sources,
    scenes: ws.scenes,
    overlays: ws.overlays,
    transition: ws.transition,
    audio: { channels: ws.audio.channels, masterDb: ws.audio.masterDb, ftbAudio: ws.audio.ftbAudio },
    outputs: ws.outputs.map(({ secret, ...o }) => o),
    settings: Object.fromEntries(SHOW_SETTINGS.filter((k) => k in ws.settings).map((k) => [k, ws.settings[k]])),
  };
}

function hash(str) { // FNV-1a, 32 bit, plus length: enough to name a graphic
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `g${(h >>> 0).toString(16)}${str.length.toString(16)}`;
}

export class MixerLink extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.state = 'off'; // off, connecting, open, error
    this.error = null;
    this.status = null;
    this.info = null;
    this.ws = null;
    this.sent = {};
    this.uploaded = new Set();
    this.gfxCache = new Map(); // render key -> {key, x, y, w, h}
    this.forwards = new Map(); // source id -> {pc, resourceUrl, stream}
    this.targets = new Map(); // canvas -> () => [sx, sy, sw, sh] | null
    this.meters = null;
    this.mv = null; // {pc, video, resourceUrl}
    this.program = null;
    this._syncTimer = null;
    this._retry = 0;
    this._draw = this._draw.bind(this);
    requestAnimationFrame(this._draw);
    setInterval(() => this._tickGraphics(), 1000);
  }

  get cfg() {
    const st = this.app.store.ws.settings;
    if (!st.mixer) st.mixer = { url: '', token: '', name: '', on: false };
    return st.mixer;
  }
  get active() { return this.state === 'open'; }
  get url() { return (this.cfg.url || '').replace(/\/+$/, ''); }

  // ------------------------------------------------------------- pairing

  static normalise(url) {
    let u = String(url || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
    try { const p = new URL(u); if (!p.port && p.protocol === 'http:' && !/\./.test(p.hostname)) p.port = '8788'; return p.origin; } catch { return ''; }
  }

  async probe(url) {
    const r = await fetch(`${url}/api/info`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`The mixer answered ${r.status}.`);
    const info = await r.json();
    if (info.app !== 'studio-mixer') throw new Error('That address is not a Studio Mixer.');
    return info;
  }

  async pairWithCode(url, code) {
    url = MixerLink.normalise(url);
    if (!url) throw new Error('Enter the mixer address.');
    let r;
    try {
      r = await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: `${location.host} studio` }) });
    } catch {
      throw new Error(`Can't reach a mixer at ${url}. ${location.protocol === 'https:' && url.startsWith('http:') && !/\/\/(localhost|127\.0\.0\.1)/.test(url)
        ? 'This page is on https, so the browser blocks plain http addresses other than localhost. Use the mixer\'s https address instead: it is shown on the mixer\'s own page (open http://localhost:8788 on the mixer computer). If the mixer runs on this computer, use Connect to it above.' : 'Check the address and that the mixer is running.'}`);
    }
    if (!r.ok) throw new Error((await r.text()) || `Pairing failed (${r.status}).`);
    const res = await r.json();
    this._adopt(url, res.token, res.name);
  }

  // A mixer on this computer: a small window from the mixer itself asks to confirm, then hands back a token.
  pairLocal(url = 'http://localhost:8788') {
    return new Promise((resolve, reject) => {
      const w = window.open(`${url}/pair?origin=${encodeURIComponent(location.origin)}`, 'studio-mixer-pair', 'width=480,height=360');
      if (!w) return reject(new Error('The browser blocked the pairing window. Allow pop-ups for this page, or pair with the code.'));
      const onMsg = (e) => {
        if (e.origin !== url.replace('localhost', 'localhost') && e.origin !== url) return;
        if (e.data?.type !== 'studio-mixer-token') return;
        window.removeEventListener('message', onMsg);
        this._adopt(url, e.data.token, '');
        resolve();
      };
      window.addEventListener('message', onMsg);
      const t = setInterval(() => { if (w.closed) { clearInterval(t); setTimeout(() => { window.removeEventListener('message', onMsg); reject(new Error('Pairing window closed.')); }, 300); } }, 500);
    });
  }

  _adopt(url, token, name) {
    Object.assign(this.cfg, { url, token, name: name || this.cfg.name || '', on: true });
    this.app.store.saveNow();
    this.connect();
  }

  forget() {
    this.disconnect();
    Object.assign(this.cfg, { url: '', token: '', name: '', on: false });
    this.app.store.saveNow();
    this.emit('state');
  }

  // ---------------------------------------------------------- connection

  connect() {
    this.disconnect(true);
    if (!this.cfg.on || !this.cfg.url || !this.cfg.token) return;
    this.state = 'connecting';
    this.error = null;
    this.emit('state');
    const wsUrl = `${this.url.replace(/^http/, 'ws')}/api/control?token=${encodeURIComponent(this.cfg.token)}`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return this._failed(e.message); }
    this.ws = ws;
    ws.onopen = () => { this._retry = 0; };
    ws.onmessage = (e) => { try { this._onMessage(JSON.parse(e.data)); } catch (err) { console.warn('mixer message', err); } };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      const wasOpen = this.state === 'open';
      this.ws = null;
      this._deactivate();
      this._failed(e.code === 1006 && !wasOpen ? `Can't reach the mixer at ${this.url}, or this studio is no longer paired with it.` : 'Connection to the mixer lost. Reconnecting…');
    };
  }

  _failed(msg) {
    this.state = 'error';
    this.error = msg;
    this.emit('state');
    if (!this.cfg.on) return;
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this.connect(), Math.min(10000, 1000 * 2 ** this._retry++));
  }

  disconnect(quiet) {
    clearTimeout(this._retryTimer);
    if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); }
    this._deactivate();
    this.state = 'off';
    if (!quiet) this.emit('state');
  }

  pause() { this.cfg.on = false; this.app.store.saveNow(); this.disconnect(); }
  resume() { this.cfg.on = true; this.app.store.saveNow(); this.connect(); }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  _onMessage(m) {
    if (m.t === 'info') { // e.g. the mixer's https address appeared or changed
      this.info = { ...this.info, ...m };
      this.emit('state');
    } else if (m.t === 'hello') {
      this.info = m;
      if (m.name && m.name !== this.cfg.name) { this.cfg.name = m.name; this.app.store.save(); }
      if (this._takeShow(m.show)) return; // reloading with the mixer's show
      this._activate();
    } else if (m.t === 'show-saved') {
      this.cfg.showRev = m.rev;
      this.app.store.saveNow();
    } else if (m.t === 'show-changed') {
      this.showChanged = true; // edited in another browser; the alert offers a reload
      this.emit('state');
    } else if (m.t === 'status') {
      this.status = m;
      this._applyStatus(m);
      this.emit('status', m);
    } else if (m.t === 'meters') {
      this.meters = m;
    }
  }

  // A browser that hasn't seen this mixer's latest show takes it and reloads, so its sources,
  // scenes and outputs are the mixer's. A mixer without a show, or one this browser saved last,
  // keeps this browser's (edits made while disconnected are sent on).
  _takeShow(show) {
    this.showChanged = false;
    const local = JSON.stringify(showOf(this.app.store.ws));
    this.sentShow = show && show.rev === this.cfg.showRev ? JSON.stringify(show.data) : null;
    if (!show || show.rev === this.cfg.showRev) return false;
    if (JSON.stringify(show.data) === local) {
      this.cfg.showRev = show.rev;
      this.sentShow = local;
      this.app.store.saveNow();
      return false;
    }
    const ws = this.app.store.ws;
    const d = show.data;
    // Keys aren't part of the show: the mixer keeps them. Keep this browser's for outputs it has.
    const secrets = new Map(ws.outputs.map((o) => [o.id, o.secret]));
    Object.assign(ws, {
      sources: d.sources || [], scenes: d.scenes || [], overlays: d.overlays || [],
      transition: d.transition || ws.transition,
      outputs: (d.outputs || []).map((o) => (secrets.get(o.id) ? { ...o, secret: secrets.get(o.id) } : o)),
    });
    ws.audio = { ...ws.audio, ...(d.audio || {}) };
    ws.settings = { ...ws.settings, ...(d.settings || {}) };
    ws.shots = { preview: null, programme: null }; // the mixer's own come with its status
    this.cfg.showRev = show.rev;
    this.app.store.saveNow();
    this.disconnect(true);
    location.reload();
    return true;
  }

  // ------------------------------------------------- entering mixer mode

  _activate() {
    const { app } = this;
    this.state = 'open';
    this.sent = {};
    this.uploaded.clear();
    app.switcher.remote = this;
    app.outputs.remote = this;
    app.sources.remote = this;
    for (const s of app.sources.all()) if (MIXER_KINDS.has(s.cfg.kind)) app.sources._teardown(s, 'mixer');
    app.compositor.paused = true;
    this._origLevels = this._origLevels || app.audio.levels.bind(app.audio);
    app.audio.levels = () => this._levels();
    // The monitor plays the mixer's programme; this page's own mix stays silent so nothing doubles.
    this._origMonitor = this._origMonitor || app.audio.applyMonitor.bind(app.audio);
    app.audio.applyMonitor = () => { app.audio._ramp(app.audio.monitor.gain, 0, 0.03); this.applyMonitor(); };
    app.audio.applyMonitor();
    this.emit('state');
    this.sync(true);
    this._startMultiview();
    for (const s of app.sources.all()) this.sourceMedia(s);
  }

  _deactivate() {
    const { app } = this;
    if (app.switcher.remote === this) app.switcher.remote = null;
    if (app.outputs.remote === this) app.outputs.remote = null;
    if (app.sources.remote === this) app.sources.remote = null;
    app.compositor.paused = false;
    if (this._origLevels) app.audio.levels = this._origLevels;
    if (this._origMonitor) { app.audio.applyMonitor = this._origMonitor; app.audio.applyMonitor(); }
    for (const id of [...this.forwards.keys()]) this._stopForward(id);
    this._stopWhep('mv');
    this._stopWhep('program');
    if (this.state === 'open') {
      // Sources and outputs that live on the mixer are not connected to this page any more.
      for (const s of app.sources.all()) if (MIXER_KINDS.has(s.cfg.kind)) app.sources._set(s, 'offline', 'Mixer not connected.');
      for (const o of app.outputs.all()) if (OUTPUT_KINDS.has(o.cfg.kind) && o.state !== 'idle') app.outputs._set(o, 'idle', 'Mixer not connected. If it is still running, the output may still be on air.');
    }
    this.status = null;
    this.meters = null;
  }

  // ------------------------------------------------------- workspace sync

  scheduleSync() {
    if (!this.active) return;
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this.sync(), 120);
  }

  async sync(first = false) {
    if (!this.active) return;
    const ws = this.app.store.ws;
    let changedTokens = false;
    for (const c of ws.sources) if (!c.mixToken) { c.mixToken = uid(16); changedTokens = true; }
    if (changedTokens) this.app.store.save();
    const payload = {
      format: ws.settings.format,
      kbps: ws.settings.mixerKbps || defaultKbps(ws.settings.format.height),
      sources: ws.sources.map((c) => ({ id: c.id, name: c.name, kind: c.kind, token: c.mixToken })),
      scenes: await this._sceneRenders(),
      overlays: await this._overlayRenders(),
      transition: ws.transition,
      audio: { channels: ws.audio.channels, masterDb: ws.audio.masterDb, ftbAudio: ws.audio.ftbAudio },
      swapOnTake: ws.settings.swapOnTake,
      outputs: this._outputs(),
    };
    if (!this.active) return;
    const show = JSON.stringify(showOf(ws));
    if (show !== this.sentShow) { this.sentShow = show; this.send({ t: 'show', data: JSON.parse(show) }); }
    const part = {};
    for (const [k, v] of Object.entries(payload)) {
      const s = JSON.stringify(v);
      if (first || this.sent[k] !== s) { part[k] = v; this.sent[k] = s; }
    }
    if (first) {
      const sw = this.app.switcher;
      part.shots = { preview: shotId(sw.preview), programme: shotId(sw.programme) };
      this.send({ t: 'hello', ws: part });
    } else if (Object.keys(part).length) {
      this.send({ t: 'state', ws: part });
    }
  }

  _outputs() {
    return this.app.outputs.all().filter((o) => OUTPUT_KINDS.has(o.cfg.kind))
      .map((o) => ({ id: o.id, kind: o.cfg.kind, name: o.cfg.name, url: o.cfg.url, key: o.token || '' }));
  }

  // ------------------------------------------------------------ graphics

  async _sceneRenders() {
    const { app } = this;
    const out = {};
    const scenes = [...app.store.ws.scenes];
    for (const s of app.sources.all()) scenes.push(app.scenes.resolve({ kind: 'source', id: s.id }));
    for (const sc of scenes) {
      if (!sc) continue;
      const id = sc.auto ? sc.id.replace(/^src:/, 'src:') : sc.id;
      out[id] = await this._flatten(sc);
    }
    return out;
  }

  // Scene -> ordered video layers and PNG graphics for everything between them.
  async _flatten(scene) {
    const f = this.app.store.ws.settings.format;
    const layers = [];
    let run = [];
    let bg = scene.bg && scene.bg !== '#000000' ? scene.bg : null;
    const flush = async () => {
      if (!run.length && !bg) return;
      const g = await this._gfxRun(run, bg, f.width, f.height);
      if (g) layers.push({ t: 'gfx', ...g });
      run = []; bg = null;
    };
    for (const l of scene.layers || []) {
      if (l.type === 'source') {
        await flush();
        if (l.sourceId) layers.push({ t: 'video', src: l.sourceId, x: l.x, y: l.y, w: l.w, h: l.h, fit: l.fit || 'cover', crop: l.crop || {}, opacity: l.opacity ?? 1 });
        if (l.border > 0 || l.label) run.push({ deco: l, name: this.app.sources.get(l.sourceId)?.cfg.name || '' });
      } else {
        run.push({ layer: l });
      }
    }
    await flush();
    return { id: scene.id, layers };
  }

  async _gfxRun(items, bg, W, H) {
    const comp = this.app.compositor;
    const desc = JSON.stringify({ items, bg, W, H });
    let missing = false;
    for (const it of items) if (it.layer?.type === 'image' && it.layer.assetId && !comp.image(it.layer.assetId)) missing = true;
    const rkey = hash(desc) + (missing ? '-wait' : '');
    if (this.gfxCache.has(rkey)) return this.gfxCache.get(rkey);
    // Bounding box of what is drawn, so the mixer blends as few pixels as possible.
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    const grow = (l) => { x0 = Math.min(x0, l.x * W); y0 = Math.min(y0, l.y * H); x1 = Math.max(x1, (l.x + l.w) * W); y1 = Math.max(y1, (l.y + l.h) * H); };
    if (bg) { x0 = 0; y0 = 0; x1 = W; y1 = H; }
    for (const it of items) grow(it.layer || it.deco);
    x0 = Math.max(0, Math.floor(x0) - 2); y0 = Math.max(0, Math.floor(y0) - 2);
    x1 = Math.min(W, Math.ceil(x1) + 2); y1 = Math.min(H, Math.ceil(y1) + 2);
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    const cv = new OffscreenCanvas(x1 - x0, y1 - y0);
    const ctx = cv.getContext('2d');
    ctx.translate(-x0, -y0);
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
    for (const it of items) {
      if (it.layer) this._drawLayer(ctx, it.layer, W, H);
      else this._drawDeco(ctx, it.deco, it.name, W, H);
    }
    const g = await this._upload(cv, rkey, x0, y0, W, H);
    if (!missing) this.gfxCache.set(rkey, g);
    if (missing) setTimeout(() => this.scheduleSync(), 400); // redraw once the image has loaded
    return g;
  }

  _drawLayer(ctx, l, W, H) {
    const comp = this.app.compositor;
    const x = l.x * W, y = l.y * H, w = l.w * W, h = l.h * H;
    ctx.globalAlpha = l.opacity ?? 1;
    if (l.type === 'rect') { ctx.fillStyle = l.color; comp._round(ctx, x, y, w, h, l.radius || 0); ctx.fill(); }
    else if (l.type === 'image') {
      const img = comp.image(l.assetId);
      if (img) comp._fitDraw(ctx, img, img.width, img.height, { l: 0, t: 0, r: 0, b: 0 }, l.fit || 'contain', x, y, w, h);
    } else if (l.type === 'text') comp._drawText(ctx, l, x, y, w, h, H);
    ctx.globalAlpha = 1;
  }

  _drawDeco(ctx, l, name, W, H) {
    const comp = this.app.compositor;
    const x = l.x * W, y = l.y * H, w = l.w * W, h = l.h * H;
    const radius = (l.radius || 0) * (H / 1080);
    if (l.border > 0) {
      ctx.lineWidth = l.border * (H / 1080);
      ctx.strokeStyle = l.borderColor || '#fff';
      comp._round(ctx, x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth, radius);
      ctx.stroke();
    }
    if (l.label && name) {
      const fs = Math.round(H * 0.026);
      ctx.font = `600 ${fs}px ${FONT}`;
      const tw = ctx.measureText(name).width;
      const pad = fs * 0.5;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x + pad, y + h - fs * 2 - pad, tw + pad * 2, fs * 1.7);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(name, x + pad * 2, y + h - fs * 1.15 - pad);
    }
  }

  async _overlayRenders() {
    const f = this.app.store.ws.settings.format;
    const out = [];
    for (const ov of this.app.store.ws.overlays) {
      const g = await this._overlayGfx(ov, f.width, f.height);
      out.push({ id: ov.id, opacity: ov.opacity ?? 1, ...(g || { key: null, x: 0, y: 0, w: 0.01, h: 0.01 }) });
    }
    return out;
  }

  _overlayTime(ov) {
    if (ov.type === 'clock') return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: ov.seconds ? '2-digit' : undefined, hour12: false });
    if (ov.type === 'ticker' && this.app.switcher.keyOn(ov.id)) return Math.floor(performance.now() / 100);
    return 0;
  }

  async _overlayGfx(ov, W, H) {
    const comp = this.app.compositor;
    const missing = ov.type === 'image' && ov.assetId && !comp.image(ov.assetId);
    const rkey = hash(JSON.stringify({ ov: { ...ov, opacity: 1 }, W, H, t: this._overlayTime(ov) })) + (missing ? '-wait' : '');
    if (this.gfxCache.has(rkey)) return this.gfxCache.get(rkey);
    const cv = new OffscreenCanvas(W, H);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    comp.drawOverlay(ctx, { ...ov, opacity: 1 }, 1, W, H, performance.now());
    // Crop to what was drawn.
    const px = ctx.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y += 2) {
      const row = y * W * 4;
      for (let x = 0; x < W; x += 2) {
        if (px[row + x * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) return null;
    x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(W, x1 + 3); y1 = Math.min(H, y1 + 3);
    const crop = new OffscreenCanvas(x1 - x0, y1 - y0);
    crop.getContext('2d').drawImage(cv, -x0, -y0);
    const g = await this._upload(crop, rkey, x0, y0, W, H);
    if (!missing && ov.type !== 'ticker') this.gfxCache.set(rkey, g);
    if (missing) setTimeout(() => this.scheduleSync(), 400);
    return g;
  }

  async _upload(canvas, key, x0, y0, W, H) {
    const g = { key, x: x0 / W, y: y0 / H, w: canvas.width / W, h: canvas.height / H };
    if (this.gfxCache.size > 300) this.gfxCache.delete(this.gfxCache.keys().next().value);
    if (!this.uploaded.has(key)) {
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      try {
        const r = await fetch(`${this.url}/api/gfx/${key}`, { method: 'PUT', headers: { Authorization: `Bearer ${this.cfg.token}` }, body: blob });
        if (r.ok) this.uploaded.add(key);
      } catch (e) { console.warn('graphic upload failed', e); }
    }
    return g;
  }

  _tickGraphics() {
    // Clocks change every second; a ticker on air scrolls (sent as fresh images).
    if (!this.active) return;
    if (this.app.store.ws.overlays.some((o) => o.type === 'clock' || (o.type === 'ticker' && this.app.switcher.keyOn(o.id)))) this.scheduleSync();
  }

  // ------------------------------------------------- sender addresses

  token(cfg) {
    if (!cfg.mixToken) { cfg.mixToken = uid(16); this.app.store.save(); }
    return cfg.mixToken;
  }

  // Where encoders send a mixer source: this mixer's address, and its network addresses when it runs on this computer.
  addresses(s) {
    const tok = this.token(s.cfg);
    const ing = this.info?.ingest || { srtPort: 8793, rtmpPort: 8794 };
    let base;
    try { base = new URL(this.url); } catch { return []; }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(base.hostname);
    const hosts = [];
    if (local) for (const l of this.info?.lan || []) { try { hosts.push({ label: 'From another device on your network', http: l.replace(/\/+$/, ''), host: new URL(l).hostname }); } catch { /* skip */ } }
    hosts.unshift({ label: local ? 'From this computer' : 'Address', http: this.url, host: local ? '127.0.0.1' : base.hostname });
    // The https address (tunnel) carries WHIP from anywhere; SRT and RTMP can't go through it.
    const pub = this.info?.public;
    if (pub && pub !== this.url) hosts.push({ label: 'From anywhere (https)', http: pub, host: null, whipOnly: true });
    return hosts.map((h) => ({
      label: h.label,
      whip: `${h.http}/api/whip/${s.id}`,
      srt: `srt://${h.host}:${ing.srtPort}?streamid=publish:in/${s.id}:src:${tok}`,
      rtmpServer: `rtmp://${h.host}:${ing.rtmpPort}/in`,
      rtmpKey: `${s.id}?user=src&pass=${tok}`,
    }));
  }

  newToken(s) {
    s.cfg.mixToken = uid(16);
    this.app.store.save();
  }

  // ------------------------------------------------------------ commands

  preview(shot) { this.send({ t: 'preview', shot: shotId(shot) }); }
  cmd(t, extra = {}) { this.send({ t, ...extra }); }

  startOutput(o) {
    this.sync().then(() => this.send({ t: 'output', action: 'start', id: o.id }));
    this.app.outputs._set(o, 'connecting', 'Starting on the mixer…');
  }
  stopOutput(o) { this.send({ t: 'output', action: 'stop', id: o.id }); }

  // --------------------------------------------------------- status in

  _applyStatus(m) {
    const { app } = this;
    const sw = app.switcher;
    sw.applyRemote({
      preview: shotFrom(m.preview), programme: shotFrom(m.programme),
      trans: m.transition?.active ? { type: m.transition.type, pos: m.transition.p, manual: m.transition.manual } : null,
      ftb: m.ftb, keys: m.keys || {},
    });
    for (const s of app.sources.all()) {
      const st = (m.sources || {})[s.id];
      if (!st) continue;
      s.mixer = st;
      if (MIXER_KINDS.has(s.cfg.kind)) {
        const live = st.state === 'connected';
        const ing = st.ingest || {};
        const how = ing.protocol ? `${ing.protocol}${ing.remote ? ` from ${ing.remote.replace(/:\d+$/, '')}` : ''}` : '';
        const detail = live ? `Live on the mixer${how ? ` (${how})` : ''}${st.width ? `, ${st.width}×${st.height}` : ''}.`
          : st.state === 'no_signal' ? 'Signal lost. The mixer reconnects as soon as the sender is back.' : 'Waiting for the sender to connect to the mixer.';
        if (s.state !== (live ? 'live' : 'waiting') || s.detail !== detail) app.sources._set(s, live ? 'live' : 'waiting', detail);
      }
    }
    for (const o of app.outputs.all()) {
      if (!OUTPUT_KINDS.has(o.cfg.kind)) continue;
      const st = (m.outputs || {})[o.id];
      if (!st) continue;
      const map = { idle: 'idle', connecting: 'connecting', live: 'live', retrying: 'unstable', error: 'failed' };
      const state = map[st.state] || 'idle';
      const detail = state === 'live' ? `On air from the mixer, ${st.kbps} kb/s.` : state === 'unstable' ? `Reconnecting… ${st.error || ''}`
        : state === 'failed' ? st.error || 'Failed.' : state === 'connecting' ? 'Connecting from the mixer…' : 'Stopped.';
      if (state === 'live' && !o.startedAt) o.startedAt = st.live_since ? st.live_since * 1000 : Date.now();
      if (state !== 'live') o.startedAt = null;
      o.mixerStats = st;
      if (o.state !== state || o.detail !== detail) app.outputs._set(o, state, detail);
    }
  }

  _levels() {
    const m = this.meters;
    const peak = (x) => (x?.peak?.length ? Math.max(...x.peak) : null);
    const out = { master: [m?.master?.peak?.[0] ?? -100, m?.master?.peak?.[1] ?? m?.master?.peak?.[0] ?? -100], ch: {} };
    for (const s of this.app.sources.all()) out.ch[s.id] = m?.sources?.[s.id] ? peak(m.sources[s.id]) : null;
    return out;
  }

  // ------------------------------------------- page sources -> mixer (WHIP)

  sourceMedia(s) {
    if (!this.active || MIXER_KINDS.has(s.cfg.kind)) return;
    const f = this.forwards.get(s.id);
    if (s.stream && (!f || f.stream !== s.stream)) this._forward(s);
    else if (!s.stream && f) this._stopForward(s.id);
  }

  async _forward(s) {
    this._stopForward(s.id);
    const stream = s.stream;
    const pc = new RTCPeerConnection();
    const f = { pc, stream, resourceUrl: null };
    this.forwards.set(s.id, f);
    for (const t of stream.getTracks()) {
      const tr = pc.addTransceiver(t, { direction: 'sendonly', streams: [stream] });
      if (t.kind === 'video') preferCodec(tr, 'video/H264');
      else preferCodec(tr, 'audio/opus');
    }
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); else { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 2000); } });
      const res = await whipPublish({ url: `${this.url}/api/whip/${s.id}`, token: this.cfg.token, sdp: pc.localDescription.sdp });
      if (this.forwards.get(s.id) !== f) { httpTeardown(res.resourceUrl, this.cfg.token); return; }
      f.resourceUrl = res.resourceUrl;
      await pc.setRemoteDescription({ type: 'answer', sdp: res.answer });
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && this.forwards.get(s.id) === f) setTimeout(() => this.sourceMedia(s), 2000);
      };
    } catch (e) {
      console.warn('forwarding to the mixer failed', e);
      if (this.forwards.get(s.id) === f) { this.forwards.delete(s.id); pc.close(); setTimeout(() => this.sourceMedia(s), 5000); }
    }
  }

  _stopForward(id) {
    const f = this.forwards.get(id);
    if (!f) return;
    this.forwards.delete(id);
    if (f.resourceUrl) httpTeardown(f.resourceUrl, this.cfg.token);
    f.pc.close();
  }

  // ---------------------------------------------- mixer -> page (WHEP)

  async _whep(path) {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const stream = new MediaStream();
    pc.ontrack = (e) => stream.addTrack(e.track);
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); else { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 2000); } });
    const res = await whepSubscribe({ url: `${this.url}/api/whep/${path}`, token: this.cfg.token, sdp: pc.localDescription.sdp });
    await pc.setRemoteDescription({ type: 'answer', sdp: res.answer });
    return { pc, stream, resourceUrl: res.resourceUrl };
  }

  async _startMultiview() {
    if (!this.active || this.mv) return;
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.autoplay = true;
    this.mv = { video, pc: null, resourceUrl: null, starting: true };
    try {
      const w = await this._whep('multiview');
      if (!this.mv || this.mv.video !== video) { w.pc.close(); return; }
      Object.assign(this.mv, w, { starting: false });
      this.previewError = null; this._mvTries = 0;
      video.srcObject = w.stream;
      video.play().catch(() => {});
      this.applyMonitor();
      w.pc.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(w.pc.connectionState) && this.mv?.pc === w.pc) {
          this._stopWhep('mv');
          setTimeout(() => this._startMultiview(), 2000);
        }
      };
    } catch (e) {
      console.warn('multiview failed', e);
      this.mv = null;
      const noH264 = !(RTCRtpReceiver.getCapabilities('video')?.codecs || []).some((c) => /h264/i.test(c.mimeType));
      this.previewError = noH264 ? 'This browser cannot play the mixer\'s preview video (H.264). Use Chrome or Edge for the studio.' : `Preview video from the mixer failed: ${e.message}`;
      this.emit('state');
      this._mvTries = (this._mvTries || 0) + 1;
      if (this.active) setTimeout(() => this._startMultiview(), Math.min(30000, 3000 * this._mvTries));
    }
  }

  // Programme audio from the mixer on this computer's speakers (MON in the audio mixer).
  applyMonitor() {
    const v = this.mv?.video;
    if (!v) return;
    const a = this.app.store.ws.audio;
    v.muted = a.monitor !== 'on';
    v.volume = Math.min(1, 10 ** ((a.monitorDb ?? -6) / 20));
  }

  async ensureProgram() {
    if (this.program?.stream) return this.program.stream;
    this.program = await this._whep('program');
    return this.program.stream;
  }

  _stopWhep(which) {
    const w = which === 'mv' ? this.mv : this.program;
    if (!w) return;
    if (which === 'mv') this.mv = null; else this.program = null;
    if (w.resourceUrl) httpTeardown(w.resourceUrl, this.cfg.token);
    w.pc?.close();
    if (w.video) w.video.srcObject = null;
  }

  // --------------------------------------------------- multiview drawing

  // Draw part of the multiview into a canvas every frame. rect() returns [sx, sy, sw, sh] in multiview pixels, or null.
  attach(canvas, rect) { this.targets.set(canvas, rect); }
  detach(canvas) { this.targets.delete(canvas); }

  tileRect(sourceId) {
    const st = this.status?.sources?.[sourceId];
    const mv = this.info?.multiview;
    if (!mv || st?.tile === null || st?.tile === undefined) return null;
    const [tw, th] = mv.tile;
    const col = st.tile % mv.cols, row = Math.floor(st.tile / mv.cols);
    return [col * tw, mv.big[1] + row * th, tw, th];
  }

  _draw(t) {
    requestAnimationFrame(this._draw);
    if (t - (this._lastDraw || 0) < 38) return; // about 25 fps, the multiview's own rate
    this._lastDraw = t;
    const v = this.mv?.video;
    if (!this.active || !v || v.readyState < 2 || !v.videoWidth) return;
    const mv = this.info?.multiview;
    const sx = v.videoWidth / (mv?.width || 1280), sy = v.videoHeight / (mv?.height || 720);
    const comp = this.app.compositor;
    const big = mv?.big || [640, 360];
    const jobs = [[comp.pvw, [0, 0, big[0], big[1]]], [comp.pgm, [big[0], 0, big[0], big[1]]]];
    for (const [cv, rect] of this.targets) { const r = rect(); if (r) jobs.push([cv, r]); }
    for (const [cv, r] of jobs) {
      const ctx = cv.getContext('2d');
      ctx.drawImage(v, r[0] * sx, r[1] * sy, r[2] * sx, r[3] * sy, 0, 0, cv.width, cv.height);
    }
  }
}

export { MIXER_KINDS, OUTPUT_KINDS, shotEq };
