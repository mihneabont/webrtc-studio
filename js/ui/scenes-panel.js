// Scenes (compositions) and Graphics (keyed overlays) tabs.
import { el, uid } from '../util.js';
import { assets } from '../store.js';
import { TEMPLATES, sceneFromTemplate, newLayer, newOverlay, sourceLayer, shotEq } from '../scenes.js';
import { field, text, num, pct, select, color, check, CardList, editingIn } from './forms.js';

function pickImage() {
  return new Promise((resolve) => {
    const i = el('input', { type: 'file', accept: 'image/*' });
    i.addEventListener('change', async () => {
      const f = i.files[0];
      if (!f) return resolve(null);
      const id = uid(6);
      try { await assets.put(id, f); resolve(id); } catch (e) { alert(`Could not store image: ${e.message}`); resolve(null); }
    });
    i.click();
  });
}

const FITS = { cover: 'Fill (crop)', contain: 'Fit (letterbox)', stretch: 'Stretch' };

export function mountScenesTab(app, root) {
  const { scenes, sources, switcher, store } = app;
  const save = () => { store.save(); };

  const tplSel = select(Object.fromEntries(Object.entries(TEMPLATES).map(([k, t]) => [k, t.name])), 'pip', () => {});
  const create = () => {
    const live = sources.all().filter((s) => s.state === 'live').map((s) => s.id);
    const ids = live.length ? [...live, ...sources.all().map((s) => s.id).filter((id) => !live.includes(id))] : sources.all().map((s) => s.id);
    const sc = scenes.add(sceneFromTemplate(tplSel.value, ids));
    edit(sc.id);
    switcher.setPreview({ kind: 'scene', id: sc.id });
    renderList();
  };
  const listBox = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
  const editor = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  root.append(
    el('div', { class: 'section-title' }, 'New scene'),
    el('div', { class: 'card' }, el('div', { class: 'btn-row' }, tplSel, el('button', { class: 'btn primary', onclick: create }, 'Create')),
      el('div', { class: 'small muted' }, 'Scenes combine sources and graphics. Slots are filled with live sources first; change them below.')),
    el('div', { class: 'section-title' }, 'Scenes'),
    listBox, editor);

  function edit(id, layerId = null) {
    app.ui.editing = id ? { sceneId: id, layerId } : null;
    app.ui.emit('editing');
    renderEditor();
    renderList();
  }

  function renderList() {
    const pg = switcher.programme, pv = switcher.preview;
    listBox.replaceChildren(...(scenes.list.length ? scenes.list.map((sc, i) => el('div', { class: `card ${app.ui.editing?.sceneId === sc.id ? 'sel' : ''}` },
      el('div', { class: 'card-head' },
        i < 9 ? el('span', { class: 'keyhint', title: `Shift+${i + 1}` }, `⇧${i + 1}`) : null,
        el('span', { class: 'card-title' }, sc.name),
        shotEq(pg, { kind: 'scene', id: sc.id }) ? el('span', { class: 'tchip pgm' }, 'PGM') : null,
        shotEq(pv, { kind: 'scene', id: sc.id }) ? el('span', { class: 'tchip pvw' }, 'PVW') : null,
        el('button', { class: 'btn sm', onclick: () => switcher.setPreview({ kind: 'scene', id: sc.id }) }, 'Preview'),
        el('button', { class: 'btn sm', onclick: () => edit(app.ui.editing?.sceneId === sc.id ? null : sc.id) }, app.ui.editing?.sceneId === sc.id ? 'Close' : 'Edit'),
        el('button', { class: 'btn ghost', title: 'Duplicate', onclick: () => { scenes.duplicate(sc.id); renderList(); } }, '⧉'),
        el('button', { class: 'btn ghost', title: 'Delete', onclick: () => {
          if (shotEq(pg, { kind: 'scene', id: sc.id })) return alert('This scene is on Programme. Take another shot first.');
          if (!confirm(`Delete scene "${sc.name}"?`)) return;
          if (shotEq(pv, { kind: 'scene', id: sc.id })) switcher.setPreview(null);
          scenes.remove(sc.id); if (app.ui.editing?.sceneId === sc.id) edit(null); renderList();
        } }, '✕')))) : [el('div', { class: 'note' }, 'No scenes yet. Clicking a multiview tile previews that source full-screen; create a scene for split-screen, picture-in-picture or multi-source layouts with graphics.')]));
  }

  function renderEditor() {
    const ed = app.ui.editing;
    const sc = ed && scenes.get(ed.sceneId);
    if (!sc) { editor.replaceChildren(); return; }
    if (editingIn(editor) && editor.dataset.scene === sc.id) { editor.dataset.stale = '1'; return; }
    editor.dataset.scene = sc.id; delete editor.dataset.stale;
    const onPgm = shotEq(switcher.programme, { kind: 'scene', id: sc.id });
    const inPvw = shotEq(switcher.preview, { kind: 'scene', id: sc.id });
    const changed = () => { save(); app.ui.emit('layer-changed'); };
    const srcOpts = { '': '— empty —', ...Object.fromEntries(sources.all().map((s) => [s.id, s.cfg.name])) };

    const layerRows = sc.layers.map((l, i) => {
      const label = l.type === 'source' ? (sources.get(l.sourceId)?.cfg.name || 'Empty slot') : l.type === 'text' ? `“${l.text.slice(0, 24)}”` : l.type === 'image' ? 'Image' : 'Box';
      return el('div', { class: `layer-row ${ed.layerId === l.id ? 'sel' : ''}`, onclick: () => edit(sc.id, l.id) },
        el('span', {}, el('span', { class: 'muted small' }, `${i + 1}. ${l.type} · `), label),
        el('span', { class: 'btn-row' },
          el('button', { class: 'btn ghost', title: 'Move back', onclick: (e) => { e.stopPropagation(); if (i > 0) { [sc.layers[i - 1], sc.layers[i]] = [sc.layers[i], sc.layers[i - 1]]; changed(); renderEditor(); } } }, '▲'),
          el('button', { class: 'btn ghost', title: 'Move forward', onclick: (e) => { e.stopPropagation(); if (i < sc.layers.length - 1) { [sc.layers[i + 1], sc.layers[i]] = [sc.layers[i], sc.layers[i + 1]]; changed(); renderEditor(); } } }, '▼'),
          el('button', { class: 'btn ghost', title: 'Delete layer', onclick: (e) => { e.stopPropagation(); sc.layers.splice(i, 1); changed(); edit(sc.id); } }, '✕')));
    });

    const addLayer = async (type) => {
      const l = type === 'source' ? sourceLayer(sources.all()[0]?.id || null, [0.6, 0.6, 0.35, 0.35]) : newLayer(type);
      if (type === 'image') { l.assetId = await pickImage(); if (!l.assetId) return; }
      sc.layers.push(l); changed(); edit(sc.id, l.id);
    };

    const sel = sc.layers.find((l) => l.id === ed.layerId);
    editor.replaceChildren(
      el('div', { class: 'section-title' }, `Edit scene`),
      el('div', { class: 'card sel' },
        onPgm ? el('div', { class: 'note warn' }, 'This scene is ON AIR. Changes appear in the programme output immediately.') : null,
        inPvw ? el('div', { class: 'small muted' }, 'Drag layers on the Preview monitor to move them; drag the corner handle to resize (Shift keeps proportions).')
          : el('div', { class: 'btn-row' }, el('span', { class: 'small muted' }, 'Put the scene in Preview to edit it visually.'), el('button', { class: 'btn sm', onclick: () => switcher.setPreview({ kind: 'scene', id: sc.id }) }, 'Preview')),
        el('div', { class: 'grid2' },
          field('Name', text(sc.name, (v) => { sc.name = v; save(); renderList(); app.ui.emit('scenes'); })),
          field('Background', color(sc.bg, (v) => { sc.bg = v; save(); }))),
        el('div', { class: 'small muted' }, 'Layers (bottom to top)'),
        ...layerRows,
        el('div', { class: 'btn-row' }, ...['source', 'text', 'image', 'rect'].map((t) => el('button', { class: 'btn sm', onclick: () => addLayer(t) }, `+ ${t === 'rect' ? 'Box' : t[0].toUpperCase() + t.slice(1)}`))),
        sel ? layerEditor(sel, srcOpts, changed) : el('div', { class: 'small muted' }, 'Select a layer to edit its properties.')));
  }

  function layerEditor(l, srcOpts, changed) {
    const geom = el('div', { class: 'grid4' },
      field('X %', pct(l.x, (v) => { l.x = v; changed(); })), field('Y %', pct(l.y, (v) => { l.y = v; changed(); })),
      field('W %', pct(l.w, (v) => { l.w = v; changed(); })), field('H %', pct(l.h, (v) => { l.h = v; changed(); })));
    const opacity = field('Opacity %', pct(l.opacity ?? 1, (v) => { l.opacity = Math.max(0, Math.min(1, v)); changed(); }));
    const box = el('div', { class: 'card', style: { background: '#12161d' } });
    if (l.type === 'source') {
      l.crop ||= { l: 0, t: 0, r: 0, b: 0 };
      box.append(
        el('div', { class: 'grid2' },
          field('Source', select(srcOpts, l.sourceId || '', (v) => { l.sourceId = v || null; changed(); renderEditor(); app.ui.emit('scenes'); switcher.emit('change'); })),
          field('Aspect', select(FITS, l.fit, (v) => { l.fit = v; changed(); }))),
        geom,
        el('div', { class: 'small muted' }, 'Crop (% of source)'),
        el('div', { class: 'grid4' }, ...['l', 't', 'r', 'b'].map((k) => field({ l: 'Left', t: 'Top', r: 'Right', b: 'Bottom' }[k],
          pct(l.crop[k], (v) => { l.crop[k] = Math.max(0, Math.min(0.45, v)); changed(); }, { min: 0, max: 45 })))),
        el('div', { class: 'grid4' },
          field('Border px', num(l.border || 0, (v) => { l.border = Math.max(0, v); changed(); }, { min: 0, max: 40 })),
          field('Colour', color(l.borderColor, (v) => { l.borderColor = v; changed(); })),
          field('Corner px', num(l.radius || 0, (v) => { l.radius = Math.max(0, v); changed(); }, { min: 0, max: 200 })),
          opacity),
        check('Show source name label', l.label, (v) => { l.label = v; changed(); }));
    } else if (l.type === 'text') {
      const ta = el('textarea', { rows: 2, style: { fontFamily: 'var(--font)', fontSize: '13px' } }); ta.value = l.text;
      ta.addEventListener('input', () => { l.text = ta.value; changed(); });
      box.append(field('Text', ta), geom,
        el('div', { class: 'grid4' },
          field('Size %H', pct(l.size, (v) => { l.size = Math.max(0.01, v); changed(); })),
          field('Colour', color(l.color, (v) => { l.color = v; changed(); })),
          field('Box', color(l.bg || '#000000', (v) => { l.bg = v + '99'; changed(); })),
          field('Align', select({ left: 'Left', center: 'Center', right: 'Right' }, l.align, (v) => { l.align = v; changed(); }))),
        el('div', { class: 'grid2' }, check('Background box', !!l.bg, (v) => { l.bg = v ? '#00000099' : ''; changed(); }), opacity));
    } else if (l.type === 'image') {
      box.append(el('div', { class: 'btn-row' }, el('button', { class: 'btn sm', onclick: async () => { const id = await pickImage(); if (id) { l.assetId = id; changed(); } } }, 'Replace image…'),
        field('Aspect', select(FITS, l.fit || 'contain', (v) => { l.fit = v; changed(); }))), geom, opacity);
    } else if (l.type === 'rect') {
      box.append(el('div', { class: 'grid4' }, field('Colour', color(l.color, (v) => { l.color = v; changed(); })),
        field('Corner px', num(l.radius || 0, (v) => { l.radius = v; changed(); })), opacity), geom);
    }
    return box;
  }

  editor.addEventListener('focusout', () => setTimeout(() => { if (editor.dataset.stale && !editingIn(editor)) renderEditor(); }, 0));
  switcher.on('change', () => { renderList(); renderEditor(); });
  app.ui.on('layer-changed', (l) => { if (l) renderEditor(); });
  app.ui.on('editing', () => { renderList(); renderEditor(); });
  sources.on('added', renderEditor);
  sources.on('removed', renderEditor);
  renderList();
  renderEditor();
}

// ---------------------------------------------------------------------------
export function mountGraphicsTab(app, root) {
  const { store, switcher, compositor } = app;
  const save = () => store.save();
  const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const openCards = new Set();
  const add = async (type) => {
    const ov = newOverlay(type);
    if (type === 'image') { ov.assetId = await pickImage(); if (!ov.assetId) return; }
    store.ws.overlays.push(ov); save(); render();
  };
  root.append(
    el('div', { class: 'section-title' }, 'Add graphic'),
    el('div', { class: 'card' },
      el('div', { class: 'btn-row' }, ...[['lowerthird', 'Lower third'], ['text', 'Text / bug'], ['image', 'Logo / image'], ['clock', 'Clock'], ['ticker', 'Ticker']]
        .map(([t, label]) => el('button', { class: 'btn sm', onclick: () => add(t) }, `+ ${label}`))),
      el('div', { class: 'small muted' }, 'Graphics are keyed over the whole Programme (and shown in Preview) and fade in and out. Use scene layers for graphics that belong to one scene.')),
    el('div', { class: 'section-title' }, 'Graphics'),
    list);

  const cards = new CardList(list, (ov) => {
    const on = switcher.keyOn(ov.id);
    const changed = () => save();
    const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    const xy = el('div', { class: 'grid4' },
      field('X %', pct(ov.x ?? 0, (v) => { ov.x = v; changed(); })), field('Y %', pct(ov.y ?? 0, (v) => { ov.y = v; changed(); })),
      'w' in ov ? field('W %', pct(ov.w, (v) => { ov.w = v; changed(); })) : null,
      'size' in ov ? field('Size %H', pct(ov.size, (v) => { ov.size = Math.max(0.01, v); changed(); })) : 'h' in ov ? field('H %', pct(ov.h, (v) => { ov.h = v; changed(); })) : null);
    if (ov.type === 'lowerthird') {
      body.append(
        field('Title', text(ov.title, (v) => { ov.title = v; changed(); }, { live: true })),
        field('Subtitle', text(ov.subtitle, (v) => { ov.subtitle = v; changed(); }, { live: true })),
        xy,
        el('div', { class: 'grid4' }, field('Bar', color(ov.color, (v) => { ov.color = v; changed(); })), field('Accent', color(ov.accent, (v) => { ov.accent = v; changed(); })),
          field('Text', color(ov.textColor, (v) => { ov.textColor = v; changed(); }))));
    } else if (ov.type === 'text') {
      const ta = el('textarea', { rows: 2, style: { fontFamily: 'var(--font)', fontSize: '13px' } }); ta.value = ov.text;
      ta.addEventListener('input', () => { ov.text = ta.value; changed(); });
      body.append(field('Text', ta), xy, el('div', { class: 'grid4' },
        field('Colour', color(ov.color, (v) => { ov.color = v; changed(); })), field('Box', color(ov.bg || '#000000', (v) => { ov.bg = v; changed(); })),
        field('Anchor', select({ left: 'Left', center: 'Center', right: 'Right' }, ov.align, (v) => { ov.align = v; changed(); }))));
    } else if (ov.type === 'image') {
      body.append(el('button', { class: 'btn sm', onclick: async () => { const id = await pickImage(); if (id) { ov.assetId = id; compositor.images.delete(id); changed(); } } }, 'Replace image…'), xy,
        el('div', { class: 'grid4' }, field('H %', pct(ov.h, (v) => { ov.h = v; changed(); })), field('Opacity %', pct(ov.opacity ?? 1, (v) => { ov.opacity = v; changed(); }))));
    } else if (ov.type === 'clock') {
      body.append(xy, el('div', { class: 'grid4' }, field('Colour', color(ov.color, (v) => { ov.color = v; changed(); })), field('Box', color(ov.bg || '#000000', (v) => { ov.bg = v + '99'; changed(); }))),
        check('Show seconds', ov.seconds, (v) => { ov.seconds = v; changed(); }));
    } else if (ov.type === 'ticker') {
      body.append(field('Label', text(ov.label, (v) => { ov.label = v; changed(); }, { live: true })),
        field('Text', text(ov.text, (v) => { ov.text = v; changed(); }, { live: true })),
        el('div', { class: 'grid4' }, field('Y %', pct(ov.y, (v) => { ov.y = v; changed(); })), field('H %', pct(ov.h, (v) => { ov.h = v; changed(); })),
          field('Size %H', pct(ov.size, (v) => { ov.size = v; changed(); })), field('Speed', num(ov.speed, (v) => { ov.speed = v; changed(); }, { step: 0.01 }))),
        el('div', { class: 'grid4' }, field('Bar', color(ov.bg, (v) => { ov.bg = v + 'e6'; changed(); })), field('Accent', color(ov.accent, (v) => { ov.accent = v; changed(); })),
          field('Text', color(ov.color, (v) => { ov.color = v; changed(); }))));
    }
    return el('div', { class: `card ${on ? 'live' : ''}` },
      el('div', { class: 'card-head' },
        el('button', { class: `btn onair-btn ${on ? 'live' : ''}`, onclick: () => { switcher.setKey(ov.id, !on); cards.refresh(ov); } }, on ? 'ON AIR' : 'OFF'),
        el('span', { class: 'card-title' }, ov.name || ov.type),
        el('button', { class: 'btn ghost', title: 'Delete', onclick: () => {
          if (!confirm(`Delete "${ov.name}"?`)) return;
          switcher.setKey(ov.id, false, 0);
          store.ws.overlays = store.ws.overlays.filter((o) => o.id !== ov.id); save(); render();
        } }, '✕')),
      el('details', { open: openCards.has(ov.id), ontoggle: (e) => (e.target.open ? openCards.add(ov.id) : openCards.delete(ov.id)) },
        el('summary', {}, 'Edit'), field('Name', text(ov.name, (v) => { ov.name = v; changed(); })), body));
  });
  const render = () => {
    cards.render(store.ws.overlays);
    if (!store.ws.overlays.length) list.replaceChildren(el('div', { class: 'note' }, 'No graphics yet.'));
  };
  render();
}
