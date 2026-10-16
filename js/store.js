// Workspace persistence. Configuration lives in localStorage; image assets in
// IndexedDB. Live connections are never persisted: after a reload every
// source and output shows as "saved, not connected" until reconnected.
import { uid, debounce } from './util.js';
import { DEFAULT_STUN } from './rtc.js';

const KEY = 'webrtc-studio.workspace.v1';

export function defaultWorkspace() {
  return {
    v: 1,
    settings: {
      ice: { stun: DEFAULT_STUN, turnUrl: '', turnUser: '', turnPass: '', forceRelay: false },
      signalingUrl: '',
      room: uid(8),
      whipProxy: '',
      format: { width: 1920, height: 1080, fps: 30 },
      previewFps: 20,
      defaultFit: 'cover',
      swapOnTake: true,
      sendTally: true,
    },
    multiview: { layout: 4, page: 0 },
    sources: [],
    scenes: [],
    overlays: [],
    transition: { type: 'mix', duration: 1000 },
    audio: { channels: {}, masterDb: 0, monitor: 'off', monitorDb: -6, ftbAudio: true },
    outputs: [],
    shots: { preview: null, programme: null },
    ui: { tab: 'sources' },
  };
}

function merge(def, saved) {
  if (Array.isArray(def)) return Array.isArray(saved) ? saved : def;
  if (def && typeof def === 'object') {
    const out = { ...def };
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(saved)) out[k] = k in def ? merge(def[k], saved[k]) : saved[k];
    }
    return out;
  }
  return saved === undefined ? def : saved;
}

export class Store {
  constructor() {
    this.loadedFromDisk = false;
    this.ws = defaultWorkspace();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { this.ws = merge(defaultWorkspace(), JSON.parse(raw)); this.loadedFromDisk = true; }
    } catch (e) {
      console.warn('Could not read saved workspace; starting fresh', e);
    }
    this.savedAt = null;
    this.onSaved = null;
    this.save = debounce(() => this.saveNow(), 300);
  }

  saveNow() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.ws));
      this.savedAt = Date.now();
      this.onSaved?.(null);
    } catch (e) {
      console.error('Saving workspace failed', e);
      this.onSaved?.(e);
    }
  }

  exportJson() {
    const copy = JSON.parse(JSON.stringify(this.ws));
    for (const o of copy.outputs) delete o.secret; // never export credentials
    delete copy.settings.linkEmail; // personal, stays in this browser
    return JSON.stringify(copy, null, 2);
  }

  importJson(text) {
    const obj = JSON.parse(text);
    if (!obj || obj.v !== 1) throw new Error('Not a WebRTC Studio workspace file.');
    localStorage.setItem(KEY, JSON.stringify(merge(defaultWorkspace(), obj)));
  }

  reset() { localStorage.removeItem(KEY); }
}

// ---------------------------------------------------------------------------
// Image assets in IndexedDB (localStorage is too small for logos).

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('webrtc-studio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('assets');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('assets', mode);
    const req = fn(t.objectStore('assets'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  }));
}
export const assets = {
  put: (id, blob) => tx('readwrite', (s) => s.put(blob, id)),
  get: (id) => tx('readonly', (s) => s.get(id)),
  del: (id) => tx('readwrite', (s) => s.delete(id)),
};

// ---------------------------------------------------------------------------
// Credentials. Browsers have no OS keychain API for web pages, so the best we
// can do is: don't store (default), or store encrypted with a passphrase
// (PBKDF2 + AES-GCM) that is never stored. Plain storage is offered but marked.

async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sealSecret(text, passphrase) {
  if (!passphrase) return { mode: 'plain', data: text };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  return { mode: 'enc', data: toB64(ct), salt: toB64(salt), iv: toB64(iv) };
}

export async function openSecret(secret, passphrase) {
  if (!secret) return '';
  if (secret.mode === 'plain') return secret.data;
  try {
    const key = await deriveKey(passphrase || '', fromB64(secret.salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(secret.iv) }, key, fromB64(secret.data));
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error('Wrong passphrase.');
  }
}
