// Studio bootstrap: creates the engine objects, wires media between them,
// and mounts the control-room UI.
import { Store } from './store.js';
import { SourceManager } from './sources.js';
import { AudioMixer } from './audio.js';
import { Scenes } from './scenes.js';
import { Switcher } from './switcher.js';
import { Compositor } from './compositor.js';
import { OutputManager } from './outputs.js';
import { Relay } from './relay.js';
import { MixerLink } from './mixer-link.js';
import { Emitter, el, $, relayWorksRemotely } from './util.js';
import { HELPER_SCHEME, HELPER_VERSION } from './ui/helper-install.js';
import { mountMonitors } from './ui/monitors.js';
import { mountMultiview } from './ui/multiview.js';
import { mountMixer } from './ui/mixer.js';
import { mountSide } from './ui/side.js';

const store = new Store();
const sources = new SourceManager(store);
const audio = new AudioMixer(store);
const scenes = new Scenes(store, sources);
const switcher = new Switcher(store, scenes, audio);
const compositor = new Compositor(store, sources, switcher);
const outputs = new OutputManager(store, compositor, audio);

const app = { store, sources, audio, scenes, switcher, compositor, outputs, relay: null, ui: new Emitter() };
window.studio = app; // handy for debugging and automated tests

// Optional Studio Mixer: when connected, it mixes and streams; this page is the control room.
app.mixer = new MixerLink(app);
{
  const save = store.save;
  store.save = () => { save(); app.mixer.scheduleSync(); };
}

// --- media wiring ----------------------------------------------------------
for (const s of sources.all()) audio._ensure(s.id);
sources.on('added', (s) => audio._ensure(s.id));
sources.on('media', (s) => { compositor.bind(s.id, s.stream); audio.attach(s.id, s.stream); app.mixer.sourceMedia(s); });
sources.on('removed', (id) => { compositor.bind(id, null); audio.remove(id); updateTally(); });

const updateTally = () => sources.setTally(switcher.pgmSources(), switcher.pvwSources());
switcher.on('change', updateTally);
updateTally();
switcher._syncAudio(0);

// --- optional signaling relay ----------------------------------------------
app.setupRelay = () => {
  app.relay?.close();
  app.relay = null;
  const st = store.ws.settings;
  // Contributor and receiver links go to other devices. A local helper can't
  // carry them (it serves OBS and RTMP only), so those use copy-paste codes.
  if (!relayWorksRemotely(st.signalingUrl)) {
    let changed = false;
    for (const c of [...store.ws.sources, ...store.ws.outputs]) {
      if ((c.kind || 'peer') === 'peer' && c.mode === 'relay') { c.mode = 'manual'; changed = true; }
    }
    if (changed) store.save();
  }
  if (st.signalingUrl) {
    app.relay = new Relay(st.signalingUrl, st.room, 'studio');
    app.relay.on('state', () => app.ui.emit('relay'));
  }
  sources.attachRelay(app.relay);
  outputs.attachRelay(app.relay);
  app.relay?.connect();
  app.ui.emit('relay');
};
app.setupRelay();

// If this page is served by the optional helper, remember its address so the
// UI can offer it (OBS/WHIP ingest needs it). Nothing is enabled automatically.
// Otherwise look for one running on this computer (installed from the OBS
// source card), so the page can be hosted anywhere.
const HELPER_PORTS = [8788, 8787];
app.detectHelper = async () => {
  const bases = [new URL('.', location.href).href.replace(/\/$/, ''), ...HELPER_PORTS.map((p) => `http://localhost:${p}`)];
  for (const base of bases) {
    try {
      const r = await fetch(`${base}/helper`, { cache: 'no-store' });
      const info = r.ok ? await r.json() : null;
      if (info?.app === 'webrtc-studio-helper') {
        const origin = base === bases[0] ? location.origin : base;
        const changed = origin !== app.helperOrigin || JSON.stringify(info) !== JSON.stringify(app.helperInfo);
        app.helperOrigin = origin;
        app.helperInfo = info;
        app.helperCheckedAt = Date.now();
        if (changed) app.ui.emit('settings');
        app.ui.emit('helper');
        return app.helperOrigin;
      }
    } catch { /* not there */ }
  }
  app.helperCheckedAt = Date.now();
  if (app.helperOrigin || app.helperInfo) { app.helperOrigin = null; app.helperInfo = null; app.ui.emit('settings'); }
  app.ui.emit('helper');
  return null;
};
app.detectHelper();
// Keep the helper status current (it can be stopped, started or reinstalled
// while the studio is open). One small local request every few seconds.
setInterval(() => { if (!document.hidden) app.detectHelper(); }, 5000);

// The Windows installer registers a URL scheme that starts the helper, so the
// page can turn it back on. Browsers ask before opening it the first time.
app.startHelper = async () => {
  const a = el('a', { href: `${HELPER_SCHEME}://start` });
  document.body.append(a); a.click(); a.remove();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await app.detectHelper()) return true;
  }
  return false;
};
app.stopHelper = async () => {
  const base = app.helperOrigin;
  if (!base) return;
  try { await fetch(`${base}/helper/stop`, { method: 'POST' }); } catch { /* it may close the connection as it exits */ }
  await new Promise((r) => setTimeout(r, 800));
  await app.detectHelper();
};
// RTMP output and SRT input go through the helper: the one found above, or the
// configured relay.
outputs.helper = () => app.helperOrigin || store.ws.settings.signalingUrl || null;
sources.helper = outputs.helper;

// --- UI --------------------------------------------------------------------
mountMonitors(app, $('#monitors'));
mountMultiview(app, $('#multiview'));
mountMixer(app, $('#mixer'));
mountSide(app, $('#side'));
app.mixer.connect();

const saveState = $('#saveState');
store.onSaved = (err) => {
  saveState.textContent = err ? 'Saving failed: storage full or blocked' : 'Workspace saved';
  saveState.style.color = err ? 'var(--bad)' : '';
};
if (store.loadedFromDisk) saveState.textContent = 'Workspace restored';

setInterval(() => {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString([], { hour12: false });
}, 250);

// --- status pills & alerts ---------------------------------------------------
const dismissed = new Set();
function renderStatus() {
  const top = $('#topStatus');
  const srcs = sources.all();
  const outs = outputs.all();
  const liveOuts = outs.filter((o) => o.state === 'live');
  const m = compositor.metrics;
  const f = store.ws.settings.format;
  const pills = [];
  pills.push(el('span', { class: `pill ${liveOuts.length ? 'onair' : ''}` }, liveOuts.length ? `ON AIR · ${liveOuts.length} output${liveOuts.length > 1 ? 's' : ''}` : 'OFF AIR'));
  pills.push(el('span', { class: 'pill' }, el('span', { class: `dot ${srcs.some((s) => s.state === 'failed') ? 'bad' : srcs.some((s) => s.state === 'live') ? 'good' : ''}` }),
    `Inputs ${srcs.filter((s) => s.state === 'live').length}/${srcs.length}`));
  pills.push(el('span', { class: 'pill' }, el('span', { class: `dot ${outs.some((o) => o.state === 'failed') ? 'bad' : liveOuts.length ? 'good' : ''}` }),
    `Outputs ${liveOuts.length}/${outs.length}`));
  const mx = app.mixer;
  const ms = mx.active ? mx.status : null;
  if (mx.cfg.url && mx.cfg.token) {
    const cls = !mx.cfg.on ? '' : mx.active ? (ms?.engineError ? 'bad' : 'good') : 'bad';
    pills.push(el('button', { class: `pill pill-btn ${mx.cfg.on && !mx.active ? 'warn' : ''}`, title: 'The Studio Mixer this studio controls. Click for details.', onpointerdown: () => app.ui.showTab?.('settings', 'mixer') },
      el('span', { class: `dot ${cls}` }), !mx.cfg.on ? 'Mixer paused' : mx.active ? `Mixer${mx.cfg.name ? `: ${mx.cfg.name}` : ''}` : mx.state === 'connecting' ? 'Mixer: connecting…' : 'Mixer unreachable'));
  }
  if (ms) {
    pills.push(el('span', { class: 'pill mono', title: 'Programme on the mixer: size, frame rate, bitrate and encoder' },
      `${ms.format.width}×${ms.format.height} · ${ms.fps ?? '–'}/${ms.format.fps} fps · ${ms.kbps} kb/s · ${ms.encoder}`));
  } else {
    pills.push(el('span', { class: `pill mono ${m.warn && m.late >= 3 ? 'warn' : ''}`, title: 'Programme render rate and time per frame' },
      `${f.width}×${f.height} · ${m.fps ? m.fps.toFixed(0) : '–'}/${f.fps} fps · ${m.renderMs ? m.renderMs.toFixed(1) : '–'} ms`));
  }
  if (!mx.active) {
    const h = app.helperInfo;
    const old = h && (h.version || 0) < HELPER_VERSION;
    const usedBy = [...sources.all().filter((s) => s.cfg.kind === 'obs' || s.cfg.kind === 'srt'), ...outputs.all().filter((o) => o.cfg.kind === 'rtmp')].length;
    const cls = h ? (old ? 'warn' : 'good') : usedBy ? 'bad' : '';
    // pointerdown: the bar is redrawn every second, which would swallow a click.
    pills.push(el('button', { class: `pill pill-btn ${h ? (old ? 'warn' : '') : usedBy ? 'warn' : ''}`, title: 'The optional helper on this computer (OBS, SRT, RTMP). Click for details.', onpointerdown: () => app.ui.showTab?.('settings', 'helper') },
      el('span', { class: `dot ${cls}` }), h ? (old ? 'Helper: update available' : 'Helper on') : 'Helper off'));
  }
  pills.push(el('span', { class: `pill ${audio.ctx.state !== 'running' ? 'warn' : ''}` }, `Audio ${audio.ctx.state === 'running' ? `${audio.ctx.sampleRate / 1000} kHz` : audio.ctx.state}`));
  if (store.ws.settings.signalingUrl) {
    const st = app.relay?.state;
    pills.push(el('span', { class: `pill ${st === 'open' ? '' : 'warn'}`, title: 'Optional signaling relay' }, el('span', { class: `dot ${st === 'open' ? 'good' : 'warn'}` }), `Relay ${st === 'open' ? 'connected' : st || 'off'}`));
  }
  top.replaceChildren(...pills);

  const alerts = [];
  if (!window.isSecureContext) alerts.push(['bad', 'This page is not served over HTTPS (or localhost). Browsers disable WebRTC media features on insecure origins.']);
  if (audio.ctx.state !== 'running') alerts.push(['warn', 'Audio engine is paused by the browser until you interact with the page. Programme audio is silent until then.', 'Start audio', () => audio.ctx.resume()]);
  if (m.warn && !mx.active) alerts.push(['warn', m.warn]);
  if (mx.cfg.on && mx.cfg.token && mx.state === 'error') alerts.push(['warn', `Studio Mixer: ${mx.error} Until it is back, the studio runs in this browser.`]);
  if (ms?.engineError) alerts.push(['bad', `The Studio Mixer could not start its mixing engine: ${ms.engineError}`]);
  const hw = hardwareWarning(srcs);
  if (hw) alerts.push(['warn', hw]);
  for (const o of liveOuts) {
    const lim = o.stats?.out?.video?.limitation;
    if (lim === 'cpu') alerts.push(['warn', `"${o.cfg.name}": the video encoder is limited by CPU, so quality is reduced. Lower the resolution or frame rate, or stop other outputs.`]);
  }
  if (store.loadedFromDisk && (srcs.length || outs.length) && !dismissed.has('restored') &&
      srcs.every((s) => s.state === 'offline' || s.state === 'waiting') && outs.every((o) => o.state === 'idle')) {
    alerts.push(['info', `Restored your saved workspace (${srcs.length} source${srcs.length === 1 ? '' : 's'}, ${store.ws.scenes.length} scene${store.ws.scenes.length === 1 ? '' : 's'}, ${outs.length} output${outs.length === 1 ? '' : 's'}). Saved settings are not live connections: reconnect sources and restart outputs.`, 'Dismiss', () => dismissed.add('restored')]);
  }
  const box = $('#alerts');
  const sig = JSON.stringify(alerts.map(([k, t]) => [k, t]));
  if (sig === box.dataset.sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(...alerts.map(([kind, text, btn, fn]) => el('div', { class: `alert ${kind}` }, el('span', {}, text),
    btn ? el('button', { class: 'btn sm', onclick: () => { fn(); box.dataset.sig = ''; renderStatus(); } }, btn) : null)));
  document.documentElement.style.setProperty('--alerts-h', `${box.offsetHeight}px`);
}

function hardwareWarning(srcs) {
  const cores = navigator.hardwareConcurrency || 4;
  const live = srcs.filter((s) => s.state === 'live');
  const px = live.reduce((a, s) => a + (s.stats?.in.video?.width || 0) * (s.stats?.in.video?.height || 0), 0);
  const fullHd = px / (1920 * 1080);
  const budget = Math.max(2, cores / 2);
  if (fullHd > budget) {
    return `Decoding about ${fullHd.toFixed(1)} 1080p-equivalent feeds on a ${cores}-thread CPU. This machine may not sustain it; watch for dropped frames, or ask contributors to send 720p.`;
  }
  const dropping = live.filter((s) => {
    const v = s.stats?.in.video;
    return v && v.fps && s.stats.in.video.receiving && v.fps < 10 && (v.kbps || 0) > 300;
  });
  if (dropping.length) return `${dropping.map((s) => `"${s.cfg.name}"`).join(', ')} decoding below 10 fps despite receiving data. The device may be overloaded.`;
  return null;
}

setInterval(renderStatus, 1000);
renderStatus();

// --- keyboard ----------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); switcher.cut(); }
  else if (e.code === 'Enter') { e.preventDefault(); switcher.auto(); }
  else if (e.key === 'b' || e.key === 'B') switcher.toggleFtb();
  else if (/^Digit[1-9]$/.test(e.code)) {
    const i = Number(e.code.slice(5)) - 1;
    if (e.shiftKey) { const sc = store.ws.scenes[i]; if (sc) switcher.setPreview({ kind: 'scene', id: sc.id }); }
    else { const s = sources.all()[i]; if (s) switcher.setPreview({ kind: 'source', id: s.id }); }
  }
});

window.addEventListener('beforeunload', (e) => {
  if (outputs.liveCount() > 0) { e.preventDefault(); e.returnValue = ''; }
});
