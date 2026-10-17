// Multiview: every source's live video in a grid with name, tally,
// connection state, stats and an audio meter. Layout changes only move
// DOM nodes; connections and decoders are never touched.
import { el, fmtKbps, fmtRes } from '../util.js';
import { SOURCE_STATES, stateLabel } from '../sources.js';
import { shotEq } from '../scenes.js';

const LAYOUTS = [1, 2, 4, 6, 9, 16];

export function mountMultiview(app, root) {
  const { sources, switcher, store } = app;
  const mv = store.ws.multiview;
  const tiles = new Map();
  const holder = el('div', { class: 'hidden' }); // off-page tiles stay in the document, so video keeps playing

  const seg = el('div', { class: 'seg' }, LAYOUTS.map((n) => el('button', { dataset: { n }, onclick: () => { mv.layout = n; mv.page = 0; store.save(); layout(); } }, String(n))));
  const pager = el('span', { class: 'btn-row' });
  const grid = el('div', { class: 'mv-grid' });
  root.append(
    el('div', { class: 'mv-head' }, el('span', { class: 'mv-title' }, 'Multiview'), seg, pager,
      el('span', { class: 'muted small', style: { marginLeft: 'auto' } }, 'Click: preview · Double-click: full screen · keys 1–9')),
    grid, holder);

  function tileFor(s) {
    let t = tiles.get(s.id);
    if (t) return t;
    const video = el('video', { muted: true, playsInline: true, autoplay: true });
    video.muted = true;
    // Mixer mode: sources that live on the mixer are drawn from its multiview stream.
    const feed = el('canvas', { class: 'mv-feed', width: 320, height: 180, hidden: true });
    const num = el('span', { class: 'tile-num' });
    const dot = el('span', { class: 'dot' });
    const name = el('span', { class: 'tile-name' });
    const tally = el('span', { class: 'tally' });
    const bottom = el('div', { class: 'tile-bottom mono' });
    const meter = el('i');
    const diag = el('div', { class: 'tile-diag' });
    const node = el('div', { class: 'tile', title: '' }, video, feed, diag,
      el('div', { class: 'tile-top' }, num, dot, name, tally), el('div', { class: 'tile-meter' }, meter), bottom);
    node.addEventListener('click', () => switcher.setPreview({ kind: 'source', id: s.id }));
    node.addEventListener('dblclick', () => {
      if (document.fullscreenElement) document.exitFullscreen(); else node.requestFullscreen?.().catch(() => {});
    });
    t = { node, video, feed, num, dot, name, tally, bottom, meter, diag };
    tiles.set(s.id, t);
    bindMedia(s);
    updateTile(s);
    return t;
  }

  function bindMedia(s) {
    const t = tiles.get(s.id);
    if (!t) return;
    if (t.video.srcObject !== s.stream) t.video.srcObject = s.stream || null;
    if (s.stream) t.video.play().catch(() => {});
    const remote = !!app.mixer?.active && !s.stream;
    t.feed.hidden = !remote;
    if (remote) app.mixer.attach(t.feed, () => app.mixer.tileRect(s.id));
    else app.mixer?.detach(t.feed);
  }

  function updateTile(s) {
    const t = tiles.get(s.id);
    if (!t) return;
    const idx = sources.all().indexOf(s);
    t.num.textContent = idx + 1;
    t.name.textContent = s.cfg.name;
    t.dot.className = `dot ${s.state}`;
    let diag = null;
    if (s.state !== 'live') {
      diag = [el('b', {}, stateLabel(s).toUpperCase()), el('span', {}, s.detail || '')];
    } else if (app.mixer?.active && !s.stream) {
      diag = null; // drawn from the mixer
    } else if (!s.hasVideo) {
      diag = [el('b', {}, 'AUDIO ONLY'), el('span', {}, 'This source sends no video.')];
    } else if (!s.videoFlowing) {
      diag = [el('b', {}, 'NO VIDEO'), el('span', {}, 'Connected, but no video packets are arriving. The contributor camera may be off or blocked.')];
    }
    t.diag.replaceChildren(...(diag || []));
    t.diag.style.display = diag ? '' : 'none';
    t.node.title = `${s.cfg.name}: ${stateLabel(s)}. ${s.detail || ''}`;
  }

  function updateStats(s) {
    const t = tiles.get(s.id);
    if (!t) return;
    const v = s.stats?.in.video, a = s.stats?.in.audio, p = s.stats?.pair;
    if (!s.stats) { t.bottom.replaceChildren(); return; }
    if (!s.stats.in) return;
    t.bottom.replaceChildren(
      el('span', {}, fmtRes(v?.width, v?.height)),
      el('span', {}, v?.fps !== undefined ? `${Math.round(v.fps)}fps` : '–'),
      el('span', {}, fmtKbps((v?.kbps || 0) + (a?.kbps || 0))),
      el('span', {}, v?.codec || ''),
      el('span', {}, p?.rtt !== undefined ? `${Math.round(p.rtt * 1000)}ms` : ''),
      el('span', { style: { color: s.stats.health === 'good' ? 'var(--good)' : s.stats.health === 'warn' ? 'var(--warn)' : 'var(--bad)' } }, `● ${s.stats.health}`),
      p?.relayed ? el('span', { title: 'Traffic goes through a TURN relay' }, 'TURN') : '',
    );
  }

  function updateTally() {
    const pgm = switcher.pgmSources(), pvw = switcher.pvwSources();
    for (const [id, t] of tiles) {
      const isPgm = pgm.has(id), isPvw = pvw.has(id);
      t.node.classList.toggle('pgm', isPgm);
      t.node.classList.toggle('pvw', isPvw);
      t.tally.replaceChildren(isPgm ? el('span', { class: 't-pgm' }, 'PGM') : '', isPvw ? el('span', { class: 't-pvw' }, 'PVW') : '');
      t.node.classList.toggle('selected', shotEq(switcher.preview, { kind: 'source', id }));
    }
  }

  function bestGrid(n) {
    const W = grid.clientWidth - 12, H = grid.clientHeight - 12;
    let best = { cols: 1, rows: n, w: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((W - (cols - 1) * 6) / cols, ((H - (rows - 1) * 6) / rows) * (16 / 9));
      if (w > best.w) best = { cols, rows, w };
    }
    return best;
  }

  function layout() {
    const n = mv.layout;
    const list = sources.all();
    const pages = Math.max(1, Math.ceil(list.length / n));
    mv.page = Math.min(mv.page, pages - 1);
    for (const b of seg.children) b.classList.toggle('on', Number(b.dataset.n) === n);
    pager.replaceChildren(...(pages > 1 ? [
      el('button', { class: 'btn sm', onclick: () => { mv.page = (mv.page + pages - 1) % pages; store.save(); layout(); } }, '◀'),
      el('span', { class: 'small muted' }, `Page ${mv.page + 1}/${pages}`),
      el('button', { class: 'btn sm', onclick: () => { mv.page = (mv.page + 1) % pages; store.save(); layout(); } }, '▶'),
    ] : []));
    const visible = list.slice(mv.page * n, mv.page * n + n);
    const g = bestGrid(n);
    grid.style.gridTemplateColumns = `repeat(${g.cols}, ${Math.floor(g.w)}px)`;
    grid.style.gridAutoRows = `${Math.floor((g.w * 9) / 16)}px`;
    // Move off-page tiles into the hidden holder, then place visible ones in order.
    for (const s of list) { const t = tileFor(s); if (!visible.includes(s)) holder.append(t.node); }
    const nodes = visible.map((s) => tileFor(s).node);
    for (let i = visible.length; i < n; i++) {
      nodes.push(el('div', { class: 'tile empty' }, i === visible.length && list.length === 0 ? 'Add a source in the Sources tab' : 'Empty'));
    }
    // Remove stale empties, then append nodes in order (moving, not recreating, video tiles).
    for (const c of [...grid.children]) if (c.classList.contains('empty')) c.remove();
    for (const node of nodes) grid.append(node);
    updateTally();
  }

  sources.on('added', layout);
  sources.on('reordered', () => { layout(); for (const s of sources.all()) updateTile(s); });
  sources.on('removed', (id) => {
    const t = tiles.get(id);
    if (t) { t.video.srcObject = null; app.mixer?.detach(t.feed); t.node.remove(); tiles.delete(id); }
    layout();
    for (const s of sources.all()) updateTile(s);
  });
  sources.on('change', updateTile);
  sources.on('media', (s) => { bindMedia(s); updateTile(s); });
  sources.on('stats', updateStats);
  app.mixer?.on('state', () => { for (const s of sources.all()) bindMedia(s); });
  // Mixer sources: resolution and how they arrive, from the mixer's status.
  app.mixer?.on('status', (m) => {
    for (const s of sources.all()) {
      const t = tiles.get(s.id), st = m.sources?.[s.id];
      if (!t || s.stream || !st) continue;
      const ing = st.ingest || {};
      t.bottom.replaceChildren(el('span', {}, fmtRes(st.width, st.height)), el('span', {}, (ing.protocol || '').toUpperCase()),
        ing.kbps ? el('span', {}, fmtKbps(ing.kbps)) : '');
    }
  });
  switcher.on('change', updateTally);
  app.ui.on('levels', (lv) => {
    for (const [id, t] of tiles) {
      const db = lv.ch[id];
      t.meter.style.height = db === null || db === undefined ? '0' : `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    }
  });
  new ResizeObserver(() => layout()).observe(grid);
  layout();
}
