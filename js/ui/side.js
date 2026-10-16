// Right-hand side panel: Sources, Scenes, Graphics, Outputs, Settings.
import { el, fmtKbps, fmtRes, fmtMs, uid } from '../util.js';
import { SOURCE_STATES, stateLabel } from '../sources.js';
import { codecSupported } from '../rtc.js';
import { field, text, select, check, linkBox, statLine, CardList } from './forms.js';
import { mountScenesTab, mountGraphicsTab } from './scenes-panel.js';
import { mountOutputsTab } from './outputs-panel.js';

const TABS = { sources: 'Sources', scenes: 'Scenes', graphics: 'Graphics', outputs: 'Outputs', settings: 'Settings' };

export function mountSide(app, root) {
  const { store } = app;
  const bodies = {};
  const tabBtns = {};
  const tabs = el('div', { class: 'tabs' }, Object.entries(TABS).map(([k, v]) => {
    tabBtns[k] = el('button', { onclick: () => show(k) }, v);
    return tabBtns[k];
  }));
  root.append(tabs);
  for (const k of Object.keys(TABS)) {
    bodies[k] = el('div', { class: 'tab-body hidden' });
    root.append(bodies[k]);
  }
  function show(k) {
    store.ws.ui.tab = k; store.save();
    for (const [id, b] of Object.entries(bodies)) b.classList.toggle('hidden', id !== k);
    for (const [id, b] of Object.entries(tabBtns)) b.classList.toggle('on', id === k);
    app.ui.emit('tab', k);
  }
  app.ui.showTab = show;

  mountSourcesTab(app, bodies.sources);
  mountScenesTab(app, bodies.scenes);
  mountGraphicsTab(app, bodies.graphics);
  mountOutputsTab(app, bodies.outputs, (n) => {
    tabBtns.outputs.replaceChildren('Outputs', n ? el('span', { class: 'badge' }, String(n)) : '');
  });
  mountSettingsTab(app, bodies.settings);
  show(TABS[store.ws.ui.tab] ? store.ws.ui.tab : 'sources');
}

// ---------------------------------------------------------------------------
function mountSourcesTab(app, root) {
  const { sources, switcher, store } = app;
  const drafts = new Map();
  const errors = new Map();

  const nameIn = el('input', { type: 'text', placeholder: 'Source name, e.g. Camera 1' });
  const kindSel = select({ peer: 'Contributor (browser link)', obs: 'OBS / WHIP encoder', whep: 'WHEP endpoint' }, 'peer', () => {});
  const add = () => {
    const s = sources.add({ name: nameIn.value.trim(), kind: kindSel.value });
    nameIn.value = '';
    if (s.cfg.kind === 'peer' && s.cfg.mode === 'manual') invite(s);
    if (s.cfg.kind === 'obs' && store.ws.settings.signalingUrl) sources.reconnect(s.id);
  };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  const intro = el('div', { class: 'note' });
  const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  root.append(
    el('div', { class: 'section-title' }, 'Add source'),
    el('div', { class: 'card' }, el('div', { class: 'btn-row' }, nameIn, kindSel, el('button', { class: 'btn primary', onclick: add }, 'Add'))),
    intro,
    el('div', { class: 'section-title' }, 'Sources'),
    list);

  function renderIntro() {
    intro.replaceChildren(store.ws.settings.signalingUrl
      ? 'Contributor sources use the optional signaling relay: send the contributor their link once; it reconnects automatically.'
      : 'No server needed: each contributor gets an invite link, and sends back a reply code you paste here. Media flows directly between browsers. (Optional: configure a signaling relay in Settings for automatic reconnection.)');
  }

  async function invite(s) {
    errors.delete(s.id);
    try { await sources.createInvite(s.id); } catch (e) { errors.set(s.id, e.message); cards.refresh(s); }
  }

  const cards = new CardList(list, (s) => {
    const pgm = switcher.pgmSources().has(s.id), pvw = switcher.pvwSources().has(s.id);
    const idx = sources.all().indexOf(s);
    const head = el('div', { class: 'card-head' },
      el('span', { class: `dot ${s.state}` }),
      el('span', { class: 'keyhint' }, String(idx + 1)),
      el('span', { class: 'card-title' }, s.cfg.name),
      pgm ? el('span', { class: 'tchip pgm' }, 'PGM') : null, pvw ? el('span', { class: 'tchip pvw' }, 'PVW') : null,
      el('button', { class: 'btn ghost', title: 'Move up', onclick: () => sources.move(s.id, -1) }, '▲'),
      el('button', { class: 'btn ghost', title: 'Move down', onclick: () => sources.move(s.id, 1) }, '▼'),
      el('button', { class: 'btn sm', onclick: () => switcher.setPreview({ kind: 'source', id: s.id }) }, 'Preview'));

    const state = el('div', { class: 'card-state' }, stateLabel(s),
      s.cfg.kind === 'whep' ? ' · WHEP' : s.cfg.kind === 'obs' ? ' · OBS / WHIP encoder' : s.cfg.mode === 'relay' ? ' · relay signaling' : ' · copy-paste signaling',
      s.info?.device ? ` · ${s.info.device}` : '');
    const detail = el('div', { class: `card-detail ${s.state === 'failed' ? 'bad' : ''}` }, s.detail || '');
    const err = errors.get(s.id) ? el('div', { class: 'card-detail bad' }, errors.get(s.id)) : null;
    const stats = el('div', { class: 'stats-slot' }, statsFor(s));

    const actions = [];
    const live = !!s.pc;
    if (s.cfg.kind === 'peer' && s.cfg.mode === 'manual') {
      if (s.state === 'invited' && s.invite) {
        const ta = el('textarea', { rows: 3, placeholder: 'Paste the reply code from the contributor page' });
        ta.value = drafts.get(s.id) || '';
        ta.addEventListener('input', () => drafts.set(s.id, ta.value));
        const accept = el('button', { class: 'btn primary', onclick: async () => {
          errors.delete(s.id);
          try { await sources.acceptAnswer(s.id, ta.value); drafts.delete(s.id); } catch (e) { errors.set(s.id, e.message); }
          cards.refresh(s);
        } }, 'Connect');
        ta.addEventListener('paste', () => setTimeout(() => accept.click(), 50));
        actions.push(el('div', { class: 'small muted' }, '1. Send this invite link to the contributor:'), linkBox(s.invite.link, 'Copy link'),
          el('div', { class: 'small muted' }, '2. Paste the reply code they send back:'), ta, el('div', { class: 'btn-row' }, accept,
            el('button', { class: 'btn', onclick: () => invite(s) }, 'New invite'), el('button', { class: 'btn', onclick: () => sources.disconnect(s.id) }, 'Cancel')));
      } else {
        actions.push(el('div', { class: 'btn-row' },
          el('button', { class: 'btn primary', onclick: () => invite(s) }, live ? 'Reconnect (new invite)' : 'Create invite'),
          live ? el('button', { class: 'btn', onclick: () => sources.disconnect(s.id) }, 'Disconnect') : null));
      }
    } else if (s.cfg.kind === 'obs') {
      actions.push(...obsActions(s, live));
    } else if (s.cfg.kind === 'peer') {
      actions.push(el('div', { class: 'small muted' }, 'Contributor link (reusable; reconnects automatically):'), linkBox(sources.relayLink(s.id), 'Copy link'),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn primary', onclick: () => sources.reconnect(s.id) }, 'Reconnect'),
          live ? el('button', { class: 'btn', onclick: () => sources.disconnect(s.id) }, 'Disconnect') : null));
    } else {
      const url = text(s.cfg.whepUrl, (v) => sources.update(s.id, { whepUrl: v.trim() }), { type: 'url', placeholder: 'https://…/whep/…' });
      const tok = el('input', { type: 'password', placeholder: 'Bearer token (optional, not saved)', value: s.token || '' });
      tok.addEventListener('change', () => { s.token = tok.value; });
      actions.push(field('WHEP URL', url), field('Token', tok), el('div', { class: 'btn-row' },
        el('button', { class: 'btn primary', onclick: () => sources.connectWhep(s.id, tok.value) }, live ? 'Reconnect' : 'Connect'),
        live ? el('button', { class: 'btn', onclick: () => sources.disconnect(s.id) }, 'Disconnect') : null));
    }

    const modeOpts = store.ws.settings.signalingUrl && s.cfg.kind === 'peer'
      ? field('Signaling', select({ manual: 'Copy-paste codes', relay: 'Signaling relay' }, s.cfg.mode, (v) => { sources.disconnect(s.id); sources.update(s.id, { mode: v }); }))
      : null;
    const settings = el('details', {}, el('summary', {}, 'Source settings'),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        field('Name', text(s.cfg.name, (v) => v.trim() && sources.update(s.id, { name: v.trim() }))),
        modeOpts,
        el('div', { class: 'btn-row' }, el('button', { class: 'btn danger sm', onclick: () => {
          if (confirm(`Remove "${s.cfg.name}"? Its connection is closed and its configuration deleted.`)) sources.remove(s.id);
        } }, 'Remove source'))));

    return el('div', { class: `card ${s.state === 'live' ? 'live' : s.state === 'failed' ? 'failed' : ''}`, dataset: { id: s.id } },
      head, state, detail, err, stats, ...actions, settings);
  });

  // A web page can't install software, so this hands the user a setup file
  // that installs Node.js if needed, fetches the helper from the site this
  // page came from, and starts it on port 8787.
  function downloadHelperInstaller() {
    const src = new URL('signaling-server/server.mjs', location.href).href;
    const cmd = [
      '@echo off',
      'title WebRTC Studio helper',
      'setlocal',
      'set "DIR=%LOCALAPPDATA%\\WebRTCStudioHelper"',
      'set "NODE=node"',
      'where node >nul 2>nul && goto havenode',
      'set "NODE=%ProgramFiles%\\nodejs\\node.exe"',
      'if exist "%NODE%" goto havenode',
      'echo Installing Node.js LTS. Windows may ask for permission...',
      'winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements',
      'if exist "%NODE%" goto havenode',
      'echo Node.js did not install. Install it from https://nodejs.org and run this file again.',
      'pause',
      'exit /b 1',
      ':havenode',
      'if not exist "%DIR%" mkdir "%DIR%"',
      `echo Downloading the helper from ${src}`,
      `powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing '${src}' -OutFile '%DIR%\\server.mjs'"`,
      'if not exist "%DIR%\\server.mjs" (',
      '  echo Download failed.',
      '  pause',
      '  exit /b 1',
      ')',
      '> "%DIR%\\start-helper.cmd" echo @"%NODE%" "%DIR%\\server.mjs" --port 8787',
      'echo.',
      'echo The helper is running on http://localhost:8787. Keep this window open while you use the studio.',
      'echo To start it again later, run %DIR%\\start-helper.cmd',
      'echo.',
      '"%NODE%" "%DIR%\\server.mjs" --port 8787',
      'pause',
    ].join('\r\n') + '\r\n';
    const a = el('a', { href: URL.createObjectURL(new Blob([cmd], { type: 'application/octet-stream' })), download: 'webrtc-studio-helper-setup.cmd' });
    document.body.append(a); a.click(); a.remove();
  }

  function obsActions(s, live) {
    const st = store.ws.settings;
    if (!st.signalingUrl) {
      const helper = app.helperOrigin;
      return [el('div', { class: 'note warn' },
        'OBS sends its stream with an HTTP request, which a web page cannot receive. This needs the small optional helper (signaling-server/server.mjs) running next to the studio. ',
        'It only passes the connection details on; the video goes straight from OBS to this browser.'),
      helper
        ? el('div', { class: 'btn-row' }, el('button', { class: 'btn primary', onclick: () => {
          st.signalingUrl = helper; store.save(); app.setupRelay(); app.ui.emit('settings');
        } }, `Use the helper at ${helper}`))
        : el('div', {},
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', onclick: downloadHelperInstaller }, 'Install helper (Windows)'),
            el('button', { class: 'btn', onclick: async (e) => {
              e.target.textContent = 'Looking…';
              if (!(await app.detectHelper())) { e.target.textContent = 'Not found. Check again'; }
            } }, 'Check again')),
          el('div', { class: 'small muted' },
            'Downloads a small setup file. Run it (Windows may ask to confirm, and to install Node.js the first time); it starts the helper on this computer at port 8787. Keep its window open, then click Check again. ',
            'On macOS or Linux: install Node.js and run node signaling-server/server.mjs --port 8787.'))];
    }
    return [
      el('div', { class: 'small muted' }, 'In OBS: Settings → Stream → Service: WHIP. Paste these two values:'),
      field('Server', linkBox(sources.obsUrl(s.id), 'Copy')),
      field('Bearer Token', linkBox(s.cfg.token, 'Copy')),
      el('div', { class: 'small muted' }, 'Use an H.264 encoder in OBS (Settings → Output), keyframe interval 1-2 s, up to about 8000 kb/s. Start Streaming in OBS and the source connects by itself.'),
      el('div', { class: 'btn-row' },
        live ? el('button', { class: 'btn', onclick: () => sources.disconnect(s.id) }, 'Disconnect')
          : s.state !== 'waiting' ? el('button', { class: 'btn primary', onclick: () => sources.reconnect(s.id) }, 'Accept encoder') : null,
        el('button', { class: 'btn sm', title: 'Invalidate the old token', onclick: () => { sources.update(s.id, { token: uid(12) }); } }, 'New token')),
    ];
  }

  function statsFor(s) {
    const st = s.stats;
    if (!st) return '';
    const v = st.in.video, a = st.in.audio, p = st.pair;
    return statLine([
      ['res', v ? fmtRes(v.width, v.height) : null], ['fps', v?.fps !== undefined ? Math.round(v.fps) : null],
      ['video', v ? fmtKbps(v.kbps) : null], ['audio', a ? fmtKbps(a.kbps) : 'none'],
      ['codec', [v?.codec, a?.codec].filter(Boolean).join('/')], ['loss', v ? `${((v.loss || 0) * 100).toFixed(1)}%` : null],
      ['jitter', v?.jitter !== undefined ? fmtMs(v.jitter) : null], ['rtt', p?.rtt !== undefined ? fmtMs(p.rtt) : null],
      ['path', p ? `${p.local} → ${p.remote}` : null], ['dropped', v?.dropped], ['freezes', v?.freezes], ['decoder', v?.decoder],
      ['health', st.health],
    ]);
  }

  const renderAll = () => { renderIntro(); cards.render(sources.all()); };
  sources.on('added', renderAll);
  sources.on('removed', renderAll);
  sources.on('reordered', renderAll);
  sources.on('change', (s) => cards.refresh(s));
  sources.on('stats', (s) => {
    const slot = cards.cards.get(s.id)?.querySelector('.stats-slot');
    if (slot) slot.replaceChildren(statsFor(s));
  });
  switcher.on('change', () => { for (const s of sources.all()) cards.refresh(s); });
  app.ui.on('settings', renderAll);
  renderAll();
}

// ---------------------------------------------------------------------------
function mountSettingsTab(app, root) {
  const { store, compositor, outputs } = app;
  const st = store.ws.settings;
  const save = () => store.save();
  const ice = st.ice;

  const sigUrl = text(st.signalingUrl, (v) => { st.signalingUrl = v.trim().replace(/\/+$/, ''); save(); app.setupRelay(); app.ui.emit('settings'); },
    { type: 'url', placeholder: 'Optional, e.g. https://signal.example.com' });
  const room = el('input', { type: 'text', value: st.room, readOnly: true, class: 'mono' });

  const fileIn = el('input', { type: 'file', accept: 'application/json', class: 'hidden' });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try { store.importJson(await f.text()); location.reload(); } catch (e) { alert(`Import failed: ${e.message}`); }
  });

  const caps = [
    ['CPU threads', navigator.hardwareConcurrency || 'unknown'],
    ['Memory', navigator.deviceMemory ? `≥ ${navigator.deviceMemory} GB` : 'not reported'],
    ['H.264 encode', codecSupported('video', 'video/H264') ? 'yes' : 'no'],
    ['VP8 / VP9 / AV1', ['VP8', 'VP9', 'AV1'].map((c) => `${c} ${codecSupported('video', `video/${c}`) ? '✓' : '✗'}`).join('  ')],
    ['Canvas capture', compositor.manualFrames ? 'frame-accurate (requestFrame)' : 'timer based'],
    ['Secure context', window.isSecureContext ? 'yes' : 'no'],
  ];

  root.append(
    el('div', { class: 'section-title' }, 'Connection infrastructure (all optional)'),
    el('div', { class: 'note' },
      'This app needs only static hosting. The items below are optional helpers for difficult networks. ',
      'STUN discovers public addresses; TURN relays media when two networks cannot connect directly (strict NAT/firewalls). ',
      'Without TURN, some contributor networks will not connect at all.'),
    el('div', { class: 'card' },
      field('STUN servers', text(ice.stun, (v) => { ice.stun = v.trim(); save(); }, { placeholder: 'stun:stun.l.google.com:19302' }), 'Space-separated. Leave empty for LAN-only operation.'),
      field('TURN server URL', text(ice.turnUrl, (v) => { ice.turnUrl = v.trim(); save(); }, { placeholder: 'turn:turn.example.com:3478?transport=udp' })),
      el('div', { class: 'grid2' },
        field('TURN username', text(ice.turnUser, (v) => { ice.turnUser = v; save(); })),
        field('TURN password', (() => { const i = el('input', { type: 'password', value: ice.turnPass }); i.addEventListener('change', () => { ice.turnPass = i.value; save(); }); return i; })())),
      check('Force relay (send everything through TURN)', ice.forceRelay, (v) => { ice.forceRelay = v; save(); }),
      el('div', { class: 'small muted' }, 'ICE settings apply to new connections. TURN credentials are stored in this browser.')),
    el('div', { class: 'card' },
      field('Signaling relay URL', sigUrl, 'Optional. Enables reusable contributor/receiver links and automatic reconnection. Carries only SDP text, never media. See signaling-server/ in the project.'),
      field('Room', el('div', { class: 'linkbox' }, room, el('button', { class: 'btn sm', onclick: () => {
        if (!confirm('Generate a new room? Existing relay links stop working.')) return;
        st.room = uid(8); room.value = st.room; save(); app.setupRelay(); app.ui.emit('settings');
      } }, 'New room'))),
      field('WHIP/WHEP CORS forwarder', text(st.whipProxy, (v) => { st.whipProxy = v.trim().replace(/\/+$/, ''); save(); }, { type: 'url', placeholder: 'Optional, e.g. https://signal.example.com' }),
        'Only needed if an ingest endpoint does not allow browser requests (CORS). Forwards the SDP request; media still goes directly from this browser to the endpoint.')),

    el('div', { class: 'section-title' }, 'Production'),
    el('div', { class: 'card' },
      check('Swap Preview and Programme on take', st.swapOnTake, (v) => { st.swapOnTake = v; save(); }),
      check('Send tally lights to contributors', st.sendTally, (v) => { st.sendTally = v; save(); }),
      check('Fade programme audio with FTB', store.ws.audio.ftbAudio, (v) => { store.ws.audio.ftbAudio = v; save(); }),
      field('Default fit for full-screen sources', select({ cover: 'Fill (crop)', contain: 'Fit (letterbox)', stretch: 'Stretch' }, st.defaultFit, (v) => { st.defaultFit = v; save(); })),
      field('Preview monitor frame rate', select({ 10: '10 fps', 15: '15 fps', 20: '20 fps', 30: '30 fps' }, st.previewFps, (v) => { st.previewFps = Number(v); save(); }), 'Lower saves CPU. Programme is unaffected.')),

    el('div', { class: 'section-title' }, 'Workspace'),
    el('div', { class: 'card' },
      el('div', { class: 'small muted' }, 'Sources, scenes, graphics, layouts, audio settings and output settings are saved automatically in this browser. Stream keys are only saved if you choose to.'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn', onclick: () => {
          const blob = new Blob([store.exportJson()], { type: 'application/json' });
          const a = el('a', { href: URL.createObjectURL(blob), download: `webrtc-studio-workspace-${new Date().toISOString().slice(0, 10)}.json` });
          a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } }, 'Export'),
        el('button', { class: 'btn', onclick: () => fileIn.click() }, 'Import…'), fileIn,
        el('button', { class: 'btn danger', onclick: () => {
          if (outputs.liveCount() && !confirm('Outputs are live. Reset anyway?')) return;
          if (confirm('Reset the workspace? All sources, scenes, graphics and outputs are deleted from this browser.')) { store.reset(); location.reload(); }
        } }, 'Reset'))),

    el('div', { class: 'section-title' }, 'This device'),
    el('dl', { class: 'kv card' }, caps.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])),

    el('div', { class: 'section-title' }, 'Keyboard'),
    el('dl', { class: 'kv card' }, [
      ['Space', 'Cut'], ['Enter', 'Auto transition'], ['B', 'Fade to black'], ['1–9', 'Source to Preview'], ['Shift + 1–9', 'Scene to Preview'],
    ].flatMap(([k, v]) => [el('dt', {}, el('span', { class: 'keyhint' }, k)), el('dd', {}, v)])),
  );
}
