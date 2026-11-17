// Small shared helpers. No dependencies.

export function uid(bytes = 6) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this.off(ev, fn);
  }
  off(ev, fn) { this._h.get(ev)?.delete(fn); }
  emit(ev, ...args) {
    for (const fn of [...(this._h.get(ev) || [])]) {
      try { fn(...args); } catch (e) { console.error(`listener for ${ev} failed`, e); }
    }
  }
}

// Tiny DOM builder: el('div', {class: 'x', onclick: fn}, child, 'text')
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function fmtKbps(kbps) {
  if (kbps === undefined || kbps === null || Number.isNaN(kbps)) return '–';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mb/s` : `${Math.round(kbps)} kb/s`;
}
export function fmtRes(w, h) { return w && h ? `${w}×${h}` : '–'; }
export function fmtFps(f) { return f || f === 0 ? `${Math.round(f)} fps` : '–'; }
export function fmtMs(s) { return s || s === 0 ? `${Math.round(s * 1000)} ms` : '–'; }

export function dbToGain(db) { return db <= -60 ? 0 : Math.pow(10, db / 20); }
export function gainToDb(g) { return g <= 0.001 ? -60 : 20 * Math.log10(g); }

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text; document.body.append(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove();
  return ok;
}

// A timer that keeps ticking when the tab is in the background.
// Main-thread timers and requestAnimationFrame get throttled or paused in
// hidden tabs, which would freeze the programme output. Worker timers don't.
// Back-pressure: a tick is only sent once the previous one was handled, and
// after a slow frame the worker waits a little so the UI thread stays
// responsive (frames are dropped instead of queueing up).
export class WorkerTicker {
  constructor(fn) {
    this.fn = fn;
    const src = `let t=null,ready=true;onmessage=e=>{if(typeof e.data==='object'){setTimeout(()=>{ready=true},e.data.rest);return}
      clearInterval(t);if(e.data>0)t=setInterval(()=>{if(ready){ready=false;postMessage(0)}},e.data)}`;
    this.w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    this.w.onmessage = () => {
      const t0 = performance.now();
      try { this.fn(); } finally {
        const d = performance.now() - t0;
        this.w.postMessage({ rest: d > 20 ? d * 0.5 : 0 });
      }
    };
  }
  start(intervalMs) { this.w.postMessage(intervalMs); }
  stop() { this.w.postMessage(0); }
}

export function relTime(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
