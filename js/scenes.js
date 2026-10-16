// Composition model. A "shot" is what Preview or Programme shows: either a
// single source full-frame ({kind:'source', id}) or a saved scene
// ({kind:'scene', id}). Positions are normalised (0..1) so scenes survive
// changes of programme resolution.
import { uid } from './util.js';

export const shotEq = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id;

export const TEMPLATES = {
  full: { name: 'Full screen', slots: [[0, 0, 1, 1]] },
  split: { name: 'Split screen', slots: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] },
  sbs: { name: 'Side by side', slots: [[0.02, 0.2275, 0.47, 0.545], [0.51, 0.2275, 0.47, 0.545]], fit: 'cover', bg: '#101826' },
  pip: { name: 'Picture in picture', slots: [[0, 0, 1, 1], [0.665, 0.06, 0.3, 0.3]], border: true },
  quad: { name: '2×2 grid', slots: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
  onePlusTwo: { name: '1 + 2', slots: [[0, 0, 0.6667, 1], [0.6667, 0, 0.3333, 0.5], [0.6667, 0.5, 0.3333, 0.5]] },
  three: { name: '3 across', slots: [[0, 0.1667, 0.3333, 0.6667], [0.3333, 0.1667, 0.3333, 0.6667], [0.6667, 0.1667, 0.3333, 0.6667]], bg: '#101826' },
};

export function sourceLayer(sourceId, [x, y, w, h], extra = {}) {
  return {
    id: uid(4), type: 'source', sourceId, x, y, w, h, fit: 'cover',
    crop: { l: 0, t: 0, r: 0, b: 0 }, label: false, border: 0, borderColor: '#ffffff', radius: 0, opacity: 1, ...extra,
  };
}

export function sceneFromTemplate(key, sourceIds, name) {
  const t = TEMPLATES[key];
  return {
    id: uid(4), name: name || t.name, bg: t.bg || '#000000',
    layers: t.slots.map((slot, i) => sourceLayer(sourceIds[i % Math.max(1, sourceIds.length)] || null, slot,
      t.border && i > 0 ? { border: 4, borderColor: '#ffffff' } : {})),
  };
}

export function newLayer(type) {
  const base = { id: uid(4), type, x: 0.1, y: 0.1, w: 0.3, h: 0.15, opacity: 1 };
  if (type === 'text') return { ...base, text: 'Text', size: 0.06, color: '#ffffff', bg: '#00000099', align: 'left', weight: 700 };
  if (type === 'image') return { ...base, assetId: null, w: 0.2, h: 0.2 };
  if (type === 'rect') return { ...base, color: '#1e293b' };
  return base;
}

export function newOverlay(type) {
  const base = { id: uid(4), type, name: '', opacity: 1 };
  switch (type) {
    case 'lowerthird': return { ...base, name: 'Lower third', title: 'Presenter Name', subtitle: 'Title or location', x: 0.06, y: 0.76, w: 0.46, color: '#0f172a', accent: '#e11d48', textColor: '#ffffff' };
    case 'text': return { ...base, name: 'Caption', text: 'LIVE', x: 0.04, y: 0.05, size: 0.045, color: '#ffffff', bg: '#e11d48', align: 'left', weight: 800 };
    case 'image': return { ...base, name: 'Logo', assetId: null, x: 0.84, y: 0.05, w: 0.12, h: 0.12 };
    case 'clock': return { ...base, name: 'Clock', x: 0.86, y: 0.9, size: 0.035, color: '#ffffff', bg: '#00000099', seconds: true };
    case 'ticker': return { ...base, name: 'Ticker', text: 'Breaking: add your ticker text here', y: 0.93, h: 0.07, size: 0.035, color: '#ffffff', bg: '#0f172ae6', accent: '#e11d48', label: 'NEWS', speed: 0.08 };
    default: return base;
  }
}

export class Scenes {
  constructor(store, sources) {
    this.store = store;
    this.sources = sources;
  }
  get list() { return this.store.ws.scenes; }
  get(id) { return this.list.find((s) => s.id === id); }

  add(scene) { this.list.push(scene); this.store.save(); return scene; }
  remove(id) { this.store.ws.scenes = this.list.filter((s) => s.id !== id); this.store.save(); }
  duplicate(id) {
    const s = this.get(id);
    if (!s) return null;
    const copy = JSON.parse(JSON.stringify(s));
    copy.id = uid(4); copy.name = `${s.name} copy`;
    for (const l of copy.layers) l.id = uid(4);
    return this.add(copy);
  }

  // Shot -> scene object for rendering.
  resolve(shot) {
    if (!shot) return null;
    if (shot.kind === 'scene') return this.get(shot.id) || null;
    if (shot.kind === 'source') {
      const src = this.sources.get(shot.id);
      if (!src) return null;
      return {
        id: `src:${shot.id}`, name: src.cfg.name, bg: '#000000', auto: true,
        layers: [sourceLayer(shot.id, [0, 0, 1, 1], { fit: this.store.ws.settings.defaultFit, id: 'auto' })],
      };
    }
    return null;
  }

  label(shot) {
    if (!shot) return 'Nothing';
    if (shot.kind === 'source') return this.sources.get(shot.id)?.cfg.name || 'Removed source';
    return this.get(shot.id)?.name || 'Removed scene';
  }

  sourcesIn(shot) {
    const sc = this.resolve(shot);
    const ids = new Set();
    for (const l of sc?.layers || []) if (l.type === 'source' && l.sourceId && (l.opacity ?? 1) > 0) ids.add(l.sourceId);
    return ids;
  }
}
