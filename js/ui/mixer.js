// Audio mixer strips: one per source plus the programme master.
import { el, clamp } from '../util.js';

const MODES = { afv: 'AFV', on: 'Always on', off: 'Off' };

export function mountMixer(app, root) {
  const { audio, sources, store } = app;
  const inner = el('div', { class: 'mixer-inner' });
  root.append(inner);
  const strips = new Map();
  const peaks = new Map();

  function fader(value, onInput) {
    const r = el('input', { type: 'range', min: -60, max: 10, step: 0.5, value });
    r.addEventListener('input', () => onInput(Number(r.value)));
    r.addEventListener('dblclick', () => { r.value = 0; onInput(0); });
    return r;
  }

  function meter() { const i = el('i'), b = el('b'); return { node: el('div', { class: 'meter' }, i, b), i, b }; }

  function build() {
    inner.replaceChildren();
    strips.clear();
    for (const s of sources.all()) {
      const cfg = audio.chCfg(s.id);
      const m = meter();
      const db = el('div', { class: 'strip-db mono' });
      const showDb = () => { db.textContent = cfg.db <= -60 ? '-∞ dB' : `${cfg.db > 0 ? '+' : ''}${cfg.db.toFixed(1)} dB`; };
      const f = fader(cfg.db, (v) => { audio.set(s.id, { db: v }); showDb(); });
      const mute = el('button', { class: 'btn', title: 'Mute', onclick: () => audio.set(s.id, { muted: !cfg.muted }) }, 'MUTE');
      const pfl = el('button', { class: 'btn', title: 'Pre-fade listen on the local monitor', onclick: () => audio.set(s.id, { pfl: !cfg.pfl }) }, 'PFL');
      const mode = el('select', { class: 'mode-sel', title: 'AFV: audio is on air only while this source is visible in Programme' },
        Object.entries(MODES).map(([k, v]) => el('option', { value: k, selected: cfg.mode === k }, v)));
      mode.addEventListener('change', () => audio.set(s.id, { mode: mode.value }));
      const name = el('div', { class: 'strip-name', title: s.cfg.name }, s.cfg.name);
      const node = el('div', { class: 'strip' }, name, el('div', { class: 'strip-mid' }, m.node, f), db, el('div', { class: 'strip-btns' }, mute, pfl), mode);
      showDb();
      strips.set(s.id, { node, m, mute, pfl, mode, cfg, name, f });
      inner.append(node);
    }
    // Master
    const ws = store.ws.audio;
    const mL = meter(), mR = meter();
    const mdb = el('div', { class: 'strip-db mono' });
    const showM = () => { mdb.textContent = `${ws.masterDb > 0 ? '+' : ''}${ws.masterDb.toFixed(1)} dB`; };
    const mf = fader(ws.masterDb, (v) => { ws.masterDb = v; audio.applyMaster(); store.save(); showM(); });
    const mon = el('button', { class: 'btn', title: 'Listen to programme (or PFL) on this computer. Off by default to avoid feedback.', onclick: () => { ws.monitor = ws.monitor === 'on' ? 'off' : 'on'; audio.applyMonitor(); store.save(); sync(); } }, 'MON');
    const monVol = el('input', { type: 'range', min: -40, max: 0, step: 1, value: ws.monitorDb, title: 'Monitor level', style: { width: '100%' } });
    monVol.addEventListener('input', () => { ws.monitorDb = Number(monVol.value); audio.applyMonitor(); store.save(); });
    showM();
    const master = el('div', { class: 'strip master' }, el('div', { class: 'strip-name' }, 'PROGRAM'),
      el('div', { class: 'strip-mid' }, mL.node, mR.node, mf), mdb, mon, monVol);
    strips.set('__master', { mL, mR, mon });
    inner.append(master);
    if (!sources.all().length) inner.prepend(el('div', { class: 'muted small', style: { alignSelf: 'center', padding: '0 12px' } }, 'Audio channels appear here when you add sources.'));
    sync();
  }

  function sync() {
    for (const s of sources.all()) {
      const st = strips.get(s.id);
      if (!st) continue;
      st.name.textContent = s.cfg.name;
      st.mute.classList.toggle('mute-on', st.cfg.muted);
      st.pfl.classList.toggle('pfl-on', st.cfg.pfl);
      const has = audio.hasAudio(s.id);
      st.node.classList.toggle('noaudio', !has);
      st.node.classList.toggle('onair', has && audio.isOnAir(s.id));
      st.node.title = has ? '' : 'No audio track from this source';
    }
    const m = strips.get('__master');
    if (m) m.mon.classList.toggle('on', store.ws.audio.monitor === 'on');
  }

  function setMeter(m, key, db) {
    const pct = db === null || db === undefined ? 0 : clamp(((db + 60) / 60) * 100, 0, 100);
    m.i.style.height = `${pct}%`;
    const pk = Math.max(pct, (peaks.get(key) || 0) - 1.2);
    peaks.set(key, pk);
    m.b.style.bottom = `${pk}%`;
    m.b.style.display = pk > 0.5 ? '' : 'none';
  }

  let last = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    if (t - last < 33) return;
    last = t;
    const lv = audio.levels();
    for (const [id, st] of strips) {
      if (id === '__master') { setMeter(st.mL, 'L', lv.master[0]); setMeter(st.mR, 'R', lv.master[1]); }
      else setMeter(st.m, id, lv.ch[id]);
    }
    app.ui.emit('levels', lv);
  }
  requestAnimationFrame(loop);

  sources.on('added', build);
  sources.on('removed', build);
  sources.on('reordered', build);
  sources.on('change', sync);
  sources.on('media', sync);
  audio.on('change', sync);
  app.switcher.on('change', sync);
  build();
}
