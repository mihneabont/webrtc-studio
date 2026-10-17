// Preview and Programme monitors, plus the transition controls between them.
// The Preview monitor doubles as a direct-manipulation editor for the scene
// being edited (drag to move, corner handle to resize).
import { el, clamp } from '../util.js';
import { TRANSITIONS } from '../switcher.js';
import { shotEq } from '../scenes.js';

export function mountMonitors(app, root) {
  const { switcher, compositor, scenes, store } = app;

  // ----- Preview
  const pvwName = el('span', { class: 'monitor-name' });
  const pvwMeta = el('span', { class: 'monitor-meta' });
  const editLayer = el('div', { style: { position: 'absolute', inset: '0' } });
  const pvwScreen = el('div', { class: 'monitor-screen', title: 'Double-click for full screen' }, compositor.pvw, editLayer);
  pvwScreen.addEventListener('dblclick', (e) => { if (e.target === pvwScreen || e.target === compositor.pvw || e.target === editLayer) toggleFs(pvwScreen); });
  const pvw = el('div', { class: 'monitor pvw' },
    el('div', { class: 'monitor-head' }, el('span', { class: 'monitor-tag' }, 'PREVIEW'), pvwName, pvwMeta), pvwScreen);

  // ----- Programme
  const pgmName = el('span', { class: 'monitor-name' });
  const pgmMeta = el('span', { class: 'monitor-meta mono' });
  const pgmScreen = el('div', { class: 'monitor-screen', title: 'This is the exact frame sent to every output. Double-click for full screen.' }, compositor.pgm);
  pgmScreen.addEventListener('dblclick', () => toggleFs(pgmScreen));
  const pgm = el('div', { class: 'monitor pgm' },
    el('div', { class: 'monitor-head' }, el('span', { class: 'monitor-tag' }, 'PROGRAM'), pgmName, pgmMeta), pgmScreen);

  // ----- Transition controls
  const cutBtn = el('button', { class: 'take cut', title: 'Cut (Space)', onclick: () => switcher.cut() }, 'CUT');
  const autoBtn = el('button', { class: 'take auto', title: 'Auto transition (Enter)', onclick: () => switcher.auto() }, 'AUTO');
  const transBtns = Object.entries(TRANSITIONS).map(([k, label]) =>
    el('button', { class: 'btn', dataset: { t: k }, title: label, onclick: () => { store.ws.transition.type = k; store.save(); sync(); } }, label.split(' ')[0]));
  const dur = el('input', {
    type: 'number', min: 100, max: 10000, step: 100, value: store.ws.transition.duration, title: 'Transition duration (ms)',
    onchange: () => { store.ws.transition.duration = clamp(Number(dur.value) || 1000, 100, 10000); dur.value = store.ws.transition.duration; store.save(); },
  });
  const tbar = el('input', { type: 'range', min: 0, max: 1000, value: 0, title: 'T-bar: drag for a manual transition' });
  tbar.addEventListener('input', () => switcher.tbar(Number(tbar.value) / 1000));
  const ftb = el('button', { class: 'ftb', title: 'Fade to black (B)', onclick: () => switcher.toggleFtb() }, 'FTB');
  const controls = el('div', { class: 'tbar-col' },
    cutBtn, autoBtn,
    el('div', { class: 'trans-sel' }, transBtns),
    el('label', { class: 'dur' }, 'ms', dur),
    el('div', { class: 'tbar' }, tbar),
    ftb);

  root.append(pvw, controls, pgm);

  function sync() {
    pvwName.textContent = scenes.label(switcher.preview);
    pgmName.textContent = scenes.label(switcher.programme);
    const f = store.ws.settings.format;
    pgmMeta.textContent = `${f.width}×${f.height} ${f.fps}p`;
    pvwMeta.textContent = switcher.preview?.kind === 'scene' ? 'Scene' : switcher.preview ? 'Source' : '';
    for (const b of transBtns) b.classList.toggle('on', b.dataset.t === store.ws.transition.type);
    autoBtn.classList.toggle('running', switcher.inTransition && !(switcher.trans?.remoteManual ?? switcher.trans?.manual));
    ftb.classList.toggle('active', switcher.ftb.black);
    if (!switcher.trans) tbar.value = 0;
    else if (switcher.remote && switcher.trans.remoteManual && document.activeElement !== tbar) tbar.value = Math.round(switcher.trans.pos * 1000);
    drawEditor();
  }
  switcher.on('change', sync);
  compositor.on('format', sync);
  app.ui.on('scenes', sync);
  app.ui.on('editing', drawEditor);
  app.ui.on('layer-changed', drawEditor);
  sync();

  // ----- Direct manipulation on the Preview monitor
  function drawEditor() {
    editLayer.replaceChildren();
    const ed = app.ui.editing;
    if (!ed || !shotEq(switcher.preview, { kind: 'scene', id: ed.sceneId })) return;
    const scene = scenes.get(ed.sceneId);
    if (!scene) return;
    scene.layers.forEach((l) => {
      const label = l.type === 'source' ? (app.sources.get(l.sourceId)?.cfg.name || 'Empty slot') : l.type === 'text' ? `Text: ${l.text}` : l.type;
      const box = el('div', { class: `edit-layer ${ed.layerId === l.id ? 'sel' : ''}` }, el('span', { class: 'lbl' }, label), el('div', { class: 'handle' }));
      place(box, l);
      box.addEventListener('pointerdown', (e) => startDrag(e, box, scene, l));
      editLayer.append(box);
    });
  }

  function place(box, l) {
    Object.assign(box.style, { left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: `${l.w * 100}%`, height: `${l.h * 100}%` });
  }

  function snap(v) {
    for (const t of [0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1]) if (Math.abs(v - t) < 0.012) return t;
    return Math.round(v * 400) / 400;
  }

  function startDrag(e, box, scene, l) {
    e.preventDefault(); e.stopPropagation();
    app.ui.editing = { sceneId: scene.id, layerId: l.id };
    app.ui.emit('editing');
    const rect = editLayer.getBoundingClientRect();
    const resize = e.target.classList.contains('handle');
    const start = { x: e.clientX, y: e.clientY, l: { ...l } };
    const target = editLayer.querySelector('.edit-layer.sel') || box;
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / rect.width, dy = (ev.clientY - start.y) / rect.height;
      if (resize) {
        let w = Math.max(0.02, start.l.w + dx), h = Math.max(0.02, start.l.h + dy);
        if (ev.shiftKey) h = w; // normalised units: equal w and h keep the programme aspect ratio
        l.w = snap(start.l.x + w) - start.l.x; l.h = snap(start.l.y + h) - start.l.y;
      } else {
        l.x = snap(start.l.x + dx); l.y = snap(start.l.y + dy);
        const right = snap(l.x + l.w); if (right !== l.x + l.w && Math.abs(right - (l.x + l.w)) < 0.012) l.x = right - l.w;
      }
      l.w = clamp(l.w, 0.02, 2); l.h = clamp(l.h, 0.02, 2);
      place(target, l);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store.save();
      app.ui.emit('layer-changed', l);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

function toggleFs(node) {
  if (document.fullscreenElement) document.exitFullscreen();
  else node.requestFullscreen?.().catch(() => {});
}
