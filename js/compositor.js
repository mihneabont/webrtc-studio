// Video compositor. Renders the Programme into a canvas that is captured as
// the outgoing video track, and the Preview into a second canvas. The
// Programme canvas shown in the UI *is* the captured canvas, so the monitor
// always matches what outputs send. UI chrome is never drawn into it.
import { Emitter, WorkerTicker, el } from './util.js';
import { assets } from './store.js';

export class Compositor extends Emitter {
  constructor(store, sources, switcher) {
    super();
    this.store = store;
    this.sources = sources;
    this.switcher = switcher;

    this.pgm = el('canvas', { class: 'pgm-canvas' });
    this.pvw = el('canvas', { class: 'pvw-canvas' });
    this.pctx = this.pgm.getContext('2d', { alpha: false, desynchronized: false });
    this.vctx = this.pvw.getContext('2d', { alpha: false });
    this.buf = document.createElement('canvas');
    this.bctx = this.buf.getContext('2d', { alpha: false });

    // Hidden "decoder" video elements used for compositing (one per source).
    this.pool = el('div', { class: 'decoder-pool', 'aria-hidden': 'true' });
    document.body.append(this.pool);
    this.videos = new Map();
    this.images = new Map(); // assetId -> ImageBitmap | 'loading' | 'missing'

    this.applyFormat();
    this.track = null;
    this.paused = false;
    this._makeTrack();

    this.metrics = { renderMs: 0, fps: 0, target: this.fmt.fps, late: 0, warn: null };
    this._frames = 0; this._renderAcc = 0; this._lastMetric = performance.now(); this._tick = 0;
    this.ticker = new WorkerTicker(() => this.frame());
    this.ticker.start(1000 / this.fmt.fps);
  }

  get fmt() { return this.store.ws.settings.format; }

  applyFormat() {
    const { width, height } = this.fmt;
    this.pgm.width = width; this.pgm.height = height;
    this.buf.width = width; this.buf.height = height;
    const pw = 960, ph = Math.round((960 * height) / width);
    this.pvw.width = pw; this.pvw.height = ph;
    this.ticker?.start(1000 / this.fmt.fps);
    if (this.metrics) this.metrics.target = this.fmt.fps;
    this.emit('format');
  }

  _makeTrack() {
    // captureStream(0) + requestFrame(): we push exactly one frame per render.
    const stream = this.pgm.captureStream(0);
    this.track = stream.getVideoTracks()[0];
    this.manualFrames = typeof this.track.requestFrame === 'function';
    if (!this.manualFrames) {
      this.track.stop();
      this.track = this.pgm.captureStream(this.fmt.fps).getVideoTracks()[0];
    }
    if ('contentHint' in this.track) this.track.contentHint = 'motion';
  }

  // Bind a source's (re)connected stream to its decoder element.
  bind(id, stream) {
    let v = this.videos.get(id);
    if (!stream) {
      if (v) { v.srcObject = null; v.remove(); this.videos.delete(id); }
      return;
    }
    if (!v) {
      // Muted: audio is handled by the mixer. Chrome needs the remote stream
      // attached to a media element for Web Audio to receive its samples.
      v = el('video', { muted: true, playsInline: true, autoplay: true });
      v.muted = true;
      this.pool.append(v);
      this.videos.set(id, v);
    }
    if (v.srcObject !== stream) v.srcObject = stream;
    v.play().catch(() => {});
  }

  videoFor(id) {
    const v = this.videos.get(id);
    return v && v.readyState >= 2 && v.videoWidth > 0 ? v : null;
  }

  image(assetId) {
    if (!assetId) return null;
    const c = this.images.get(assetId);
    if (c instanceof ImageBitmap) return c;
    if (!c) {
      this.images.set(assetId, 'loading');
      assets.get(assetId).then((blob) => (blob ? createImageBitmap(blob) : null))
        .then((bmp) => this.images.set(assetId, bmp || 'missing'))
        .catch(() => this.images.set(assetId, 'missing'));
    }
    return null;
  }

  // ---------------------------------------------------------------------
  frame() {
    if (this.paused) return; // mixer mode: the Studio Mixer renders, the monitors show its multiview
    const t0 = performance.now();
    const plan = this.switcher.plan(t0);
    const W = this.pgm.width, H = this.pgm.height, ctx = this.pctx;
    this._drawTransition(ctx, plan, W, H, false);
    for (const { ov, v } of plan.overlays) this.drawOverlay(ctx, ov, v, W, H, t0);
    if (plan.ftb > 0) { ctx.globalAlpha = plan.ftb; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
    if (this.manualFrames) this.track.requestFrame();

    // Preview at a lower rate to save CPU.
    // Under overload, the Preview monitor gives up frames first so Programme keeps its rate.
    const every = Math.max(1, Math.round(this.fmt.fps / (this.store.ws.settings.previewFps || 15))) * (this.metrics.late >= 3 ? 3 : 1);
    if (this._tick++ % every === 0) this._renderPreview(plan, t0);

    const dt = performance.now() - t0;
    this._renderAcc += dt; this._frames++;
    if (t0 - this._lastMetric >= 1000) {
      const secs = (t0 - this._lastMetric) / 1000;
      const m = this.metrics;
      m.fps = this._frames / secs;
      m.renderMs = this._renderAcc / this._frames;
      const budget = 1000 / this.fmt.fps;
      const struggling = m.fps < this.fmt.fps * 0.9 || m.renderMs > budget * 0.7;
      m.late = struggling ? m.late + 1 : 0;
      m.warn = m.late >= 3
        ? `Rendering is falling behind: ${m.fps.toFixed(1)} of ${this.fmt.fps} fps, ${m.renderMs.toFixed(1)} ms per frame. Lower the programme resolution or frame rate, or use fewer sources.`
        : (document.hidden ? 'The studio tab is in the background. Keep it visible: browsers may slow video decoding in hidden tabs.' : null);
      this._frames = 0; this._renderAcc = 0; this._lastMetric = t0;
      this.emit('metrics', m);
    }
  }

  _renderPreview(plan, now) {
    const W = this.pvw.width, H = this.pvw.height, ctx = this.vctx;
    const scene = this.switcher.scenes.resolve(this.switcher.preview);
    this.drawScene(ctx, scene, W, H, true);
    // Show the keys currently on air, so the operator sees the next shot as it will look.
    for (const { ov, v } of plan.overlays) this.drawOverlay(ctx, ov, v, W, H, now);
    this.emit('preview-drawn', ctx, W, H);
  }

  _drawTransition(ctx, plan, W, H, preview) {
    const { a, b, p, type } = plan;
    if (!b || p <= 0) return this.drawScene(ctx, a, W, H, preview);
    if (p >= 1) return this.drawScene(ctx, b, W, H, preview);
    switch (type) {
      case 'dip': {
        const first = p < 0.5;
        this.drawScene(ctx, first ? a : b, W, H, preview);
        ctx.globalAlpha = first ? p * 2 : (1 - p) * 2;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
        break;
      }
      case 'wipe': {
        this.drawScene(ctx, a, W, H, preview);
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * p, H); ctx.clip();
        this.drawScene(ctx, b, W, H, preview);
        ctx.restore();
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(W * p - 2, 0, 4, H);
        break;
      }
      case 'push': {
        this.drawScene(this.bctx, b, W, H, preview);
        ctx.save(); ctx.translate(-W * p, 0); this.drawScene(ctx, a, W, H, preview); ctx.restore();
        ctx.drawImage(this.buf, W * (1 - p), 0);
        break;
      }
      default: { // mix / dissolve: B is composed off-screen, then blended over A
        this.drawScene(ctx, a, W, H, preview);
        this.drawScene(this.bctx, b, W, H, preview);
        ctx.globalAlpha = p; ctx.drawImage(this.buf, 0, 0); ctx.globalAlpha = 1;
      }
    }
  }

  drawScene(ctx, scene, W, H, preview) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = scene?.bg || '#000';
    ctx.fillRect(0, 0, W, H);
    if (!scene) return;
    for (const l of scene.layers) {
      const x = l.x * W, y = l.y * H, w = l.w * W, h = l.h * H;
      ctx.globalAlpha = l.opacity ?? 1;
      if (l.type === 'source') this._drawSourceLayer(ctx, l, x, y, w, h, W, H, preview);
      else if (l.type === 'rect') { ctx.fillStyle = l.color; this._round(ctx, x, y, w, h, l.radius || 0); ctx.fill(); }
      else if (l.type === 'image') {
        const img = this.image(l.assetId);
        if (img) this._fitDraw(ctx, img, img.width, img.height, { l: 0, t: 0, r: 0, b: 0 }, l.fit || 'contain', x, y, w, h);
        else if (preview) this._placeholder(ctx, x, y, w, h, 'No image', H);
      } else if (l.type === 'text') this._drawText(ctx, l, x, y, w, h, H);
      ctx.globalAlpha = 1;
    }
  }

  _drawSourceLayer(ctx, l, x, y, w, h, W, H, preview) {
    const v = l.sourceId && this.videoFor(l.sourceId);
    const radius = (l.radius || 0) * (H / 1080);
    if (v) {
      ctx.save();
      if (radius) { this._round(ctx, x, y, w, h, radius); ctx.clip(); }
      this._fitDraw(ctx, v, v.videoWidth, v.videoHeight, l.crop || {}, l.fit || 'cover', x, y, w, h);
      ctx.restore();
    } else if (preview) {
      const s = l.sourceId && this.sources.get(l.sourceId);
      this._placeholder(ctx, x, y, w, h, s ? `NO SIGNAL · ${s.cfg.name}` : 'NO SOURCE', H);
    }
    // In Programme a missing source simply shows the scene background: no UI text on air.
    if (l.border > 0) {
      ctx.lineWidth = l.border * (H / 1080);
      ctx.strokeStyle = l.borderColor || '#fff';
      this._round(ctx, x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth, radius);
      ctx.stroke();
    }
    if (l.label && l.sourceId) {
      const name = this.sources.get(l.sourceId)?.cfg.name || '';
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

  _fitDraw(ctx, src, iw, ih, crop, fit, x, y, w, h) {
    let sx = iw * (crop.l || 0), sy = ih * (crop.t || 0);
    let sw = iw * (1 - (crop.l || 0) - (crop.r || 0)), sh = ih * (1 - (crop.t || 0) - (crop.b || 0));
    if (sw <= 1 || sh <= 1) return;
    if (fit === 'stretch') return ctx.drawImage(src, sx, sy, sw, sh, x, y, w, h);
    if (fit === 'contain') {
      const s = Math.min(w / sw, h / sh);
      const dw = sw * s, dh = sh * s;
      return ctx.drawImage(src, sx, sy, sw, sh, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }
    const s = Math.max(w / sw, h / sh); // cover
    const vw = w / s, vh = h / s;
    sx += (sw - vw) / 2; sy += (sh - vh) / 2;
    ctx.drawImage(src, sx, sy, vw, vh, x, y, w, h);
  }

  _round(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (r > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  }

  _placeholder(ctx, x, y, w, h, text, H) {
    ctx.save();
    ctx.fillStyle = '#16181d'; ctx.fillRect(x, y, w, h);
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.strokeStyle = '#23262e'; ctx.lineWidth = Math.max(2, H / 120);
    for (let i = -h; i < w; i += H / 18) { ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y); ctx.stroke(); }
    ctx.fillStyle = '#8b93a7';
    ctx.font = `600 ${Math.max(10, Math.min(h * 0.09, H * 0.04))}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + h / 2);
    ctx.restore();
  }

  _drawText(ctx, l, x, y, w, h, H) {
    const fs = (l.size || 0.05) * H;
    ctx.font = `${l.weight || 700} ${fs}px ${FONT}`;
    const lines = String(l.text || '').split('\n');
    const lh = fs * 1.25;
    if (l.bg && !/^#?0{0,8}$/.test(l.bg) && l.bg !== 'transparent') { ctx.fillStyle = l.bg; ctx.fillRect(x, y, w, h); }
    ctx.fillStyle = l.color || '#fff'; ctx.textBaseline = 'middle';
    ctx.textAlign = l.align || 'left';
    const tx = l.align === 'center' ? x + w / 2 : l.align === 'right' ? x + w - fs * 0.4 : x + fs * 0.4;
    const top = y + h / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((t, i) => ctx.fillText(t, tx, top + i * lh, w - fs * 0.8));
    ctx.textAlign = 'left';
  }

  // Downstream keys (graphics over the whole programme).
  drawOverlay(ctx, ov, v, W, H, now) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, v) * (ov.opacity ?? 1);
    switch (ov.type) {
      case 'lowerthird': this._lowerThird(ctx, ov, v, W, H); break;
      case 'text': {
        const fs = ov.size * H;
        ctx.font = `${ov.weight || 700} ${fs}px ${FONT}`;
        const lines = String(ov.text).split('\n');
        const tw = Math.max(...lines.map((t) => ctx.measureText(t).width));
        const pad = fs * 0.45, lh = fs * 1.2;
        const bw = tw + pad * 2, bh = lines.length * lh + pad;
        let x = ov.x * W;
        if (ov.align === 'center') x -= bw / 2; else if (ov.align === 'right') x -= bw;
        const y = ov.y * H;
        if (ov.bg) { ctx.fillStyle = ov.bg; ctx.fillRect(x, y, bw, bh); }
        ctx.fillStyle = ov.color; ctx.textBaseline = 'middle';
        lines.forEach((t, i) => ctx.fillText(t, x + pad, y + pad / 2 + lh * (i + 0.5)));
        break;
      }
      case 'image': {
        const img = this.image(ov.assetId);
        if (img) this._fitDraw(ctx, img, img.width, img.height, {}, 'contain', ov.x * W, ov.y * H, ov.w * W, ov.h * H);
        break;
      }
      case 'clock': {
        const d = new Date();
        const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: ov.seconds ? '2-digit' : undefined, hour12: false });
        const fs = ov.size * H;
        ctx.font = `700 ${fs}px ${MONO}`;
        const tw = ctx.measureText(t).width, pad = fs * 0.4;
        const x = ov.x * W, y = ov.y * H;
        if (ov.bg) { ctx.fillStyle = ov.bg; ctx.fillRect(x, y, tw + pad * 2, fs * 1.5); }
        ctx.fillStyle = ov.color; ctx.textBaseline = 'middle';
        ctx.fillText(t, x + pad, y + fs * 0.78);
        break;
      }
      case 'ticker': this._ticker(ctx, ov, W, H, now); break;
    }
    ctx.restore();
  }

  _lowerThird(ctx, ov, v, W, H) {
    const x = ov.x * W, y = ov.y * H, w = ov.w * W;
    const th = H * 0.075, sh = ov.subtitle ? H * 0.05 : 0;
    const reveal = Math.min(1, v * 1.15);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w * (1 - Math.pow(1 - reveal, 3)), th + sh); ctx.clip();
    ctx.fillStyle = ov.color; ctx.fillRect(x, y, w, th);
    ctx.fillStyle = ov.accent; ctx.fillRect(x, y, H * 0.009, th);
    if (sh) { ctx.fillStyle = ov.accent; ctx.fillRect(x, y + th, w * 0.85, sh); }
    ctx.fillStyle = ov.textColor; ctx.textBaseline = 'middle';
    ctx.font = `700 ${th * 0.5}px ${FONT}`;
    ctx.fillText(ov.title, x + H * 0.03, y + th / 2, w - H * 0.05);
    if (sh) { ctx.font = `500 ${sh * 0.58}px ${FONT}`; ctx.fillText(ov.subtitle, x + H * 0.03, y + th + sh / 2, w * 0.85 - H * 0.05); }
    ctx.restore();
  }

  _ticker(ctx, ov, W, H, now) {
    const y = ov.y * H, h = ov.h * H, fs = ov.size * H;
    ctx.fillStyle = ov.bg; ctx.fillRect(0, y, W, h);
    ctx.font = `800 ${fs}px ${FONT}`;
    const lw = ov.label ? ctx.measureText(ov.label).width + fs * 1.2 : 0;
    ctx.font = `600 ${fs}px ${FONT}`;
    const text = `${ov.text}     •     `;
    const tw = ctx.measureText(text).width;
    const off = ((now / 1000) * ov.speed * W) % tw;
    ctx.save(); ctx.beginPath(); ctx.rect(lw, y, W - lw, h); ctx.clip();
    ctx.fillStyle = ov.color; ctx.textBaseline = 'middle';
    for (let x = lw - off; x < W; x += tw) ctx.fillText(text, x, y + h / 2);
    ctx.restore();
    if (ov.label) {
      ctx.fillStyle = ov.accent; ctx.fillRect(0, y, lw, h);
      ctx.fillStyle = '#fff'; ctx.font = `800 ${fs}px ${FONT}`; ctx.textBaseline = 'middle';
      ctx.fillText(ov.label, fs * 0.6, y + h / 2);
    }
  }
}

const FONT = '"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MONO = '"JetBrains Mono", "SF Mono", Consolas, monospace';
