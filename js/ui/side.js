// Right-hand side panel: Sources, Scenes, Graphics, Outputs, Settings.
import { el, fmtKbps, fmtRes, fmtMs, uid, relayWorksRemotely } from '../util.js';
import { SOURCE_STATES, stateLabel } from '../sources.js';
import { codecSupported } from '../rtc.js';
import { field, text, num, select, check, linkBox, statLine, CardList } from './forms.js';
import { parseYouTube, fmtClock, youTubeSupported } from '../youtube.js';
import { mountScenesTab, mountGraphicsTab } from './scenes-panel.js';
import { mountOutputsTab } from './outputs-panel.js';
import { HELPER_PORT, downloadHelperInstaller } from './helper-install.js';
import { mountHelperPanel } from './helper-panel.js';


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
  function show(k, section) {
    store.ws.ui.tab = k; store.save();
    for (const [id, b] of Object.entries(bodies)) b.classList.toggle('hidden', id !== k);
    for (const [id, b] of Object.entries(tabBtns)) b.classList.toggle('on', id === k);
    app.ui.emit('tab', k);
    if (section) bodies[k].querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
// Source types offered in the Sources tab, in this order. Icons are 24x24 line
// drawings (SVG path data), drawn in the text colour. WHEP and WHIP are a globe
// with an arrow: WHEP plays from a server (arrow down), WHIP is an encoder
// publishing (arrow up).
const GLOBE = ['M17 10a7 7 0 1 1-14 0a7 7 0 1 1 14 0', 'M3 10h14', 'M10 3a10.5 10.5 0 0 1 0 14a10.5 10.5 0 0 1 0-14'];
const SOURCE_KINDS = {
  peer: { label: 'Invite link', icon: ['M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5', 'M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5'] },
  whep: { label: 'WHEP', icon: [...GLOBE, 'M19 14v7', 'M16 18l3 3 3-3'] },
  obs: { label: 'WHIP (via helper)', icon: [...GLOBE, 'M19 21v-7', 'M16 17l3-3 3 3'] },
  srt: { label: 'SRT (via helper)', icon: ['M12 13v8', 'M9 21h6', 'M8.5 9.5a5 5 0 0 1 7 0', 'M5.5 6.5a9 9 0 0 1 13 0', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'] },
  youtube: { label: 'YouTube', icon: ['M2.5 8.5a3 3 0 0 1 2.6-2.9C7.4 5.2 9.7 5 12 5s4.6.2 6.9.6a3 3 0 0 1 2.6 2.9 30 30 0 0 1 0 7 3 3 0 0 1-2.6 2.9c-2.3.4-4.6.6-6.9.6s-4.6-.2-6.9-.6a3 3 0 0 1-2.6-2.9 30 30 0 0 1 0-7z', 'M10 9.5v5l4.5-2.5z'] },
};

function kindIcon(paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const d of paths) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}

function mountSourcesTab(app, root) {
  const { sources, switcher, store } = app;
  const drafts = new Map();
  const errors = new Map();

  const nameIn = el('input', { type: 'text', placeholder: 'Source name, e.g. Camera 1' });
  // Source type picker: a row of icon buttons; the note under it explains the chosen type.
  let kind = 'peer';
  const kindBtns = Object.entries(SOURCE_KINDS).map(([k, t]) => {
    const b = el('button', { type: 'button', class: 'kind-btn', role: 'radio', title: t.label, onclick: () => { kind = k; renderIntro(); } },
      kindIcon(t.icon), el('span', {}, t.label));
    b.dataset.kind = k;
    return b;
  });
  const kindRow = el('div', { class: 'kind-row', role: 'radiogroup', 'aria-label': 'Source type' }, kindBtns);
  const add = () => {
    const s = sources.add({ name: nameIn.value.trim(), kind });
    nameIn.value = '';
    if (s.cfg.kind === 'peer' && s.cfg.mode === 'manual') invite(s);
    if (s.cfg.kind === 'obs' && store.ws.settings.signalingUrl) sources.reconnect(s.id);
    if (s.cfg.kind === 'srt' && store.ws.settings.signalingUrl) sources.startSrt(s.id);
  };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  const intro = el('div', { class: 'note' });
  const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  // Shown instead of the list while there are no sources.
  const empty = el('div', { class: 'empty-state' },
    kindIcon(['M3 8a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M16 10l5-3v10l-5-3']),
    el('div', { class: 'empty-title' }, 'Add a source to start'),
    el('div', {}, 'Pick a type above, give it a name and click Add: send an invite link to a phone or computer, connect an encoder such as OBS or any camera that supports SRT or WebRTC. '
      + 'Each source then appears here and in the multiview, ready to put on Preview and Programme.'));
  root.append(
    el('div', { class: 'section-title' }, 'Add source'),
    el('div', { class: 'card add-source' }, kindRow, intro,
      el('div', { class: 'btn-row' }, nameIn, el('button', { class: 'btn primary btn-icon', onclick: add }, kindIcon(['M12 5v14', 'M5 12h14']), 'Add'))),
    el('div', { class: 'section-title' }, 'Sources'),
    empty,
    list);

  function renderIntro() {
    for (const b of kindBtns) {
      b.classList.toggle('on', b.dataset.kind === kind);
      b.setAttribute('aria-checked', String(b.dataset.kind === kind));
    }
    const relay = relayWorksRemotely(store.ws.settings.signalingUrl);
    const helper = app.helperInfo ? '' : ' The helper is not running on this computer yet: the new source shows how to install it.';
    const text = {
      peer: relay
        ? 'Send someone a link: they open it in a phone or computer browser and allow camera and microphone. The link is reusable and reconnects by itself through the signaling relay set in Settings. Video goes directly from their browser to this one.'
        : 'Send someone a link: they open it in a phone or computer browser, allow camera and microphone, and send back a reply code that you paste here. No server or install needed; video goes directly from their browser to this one.',
      obs: `For encoders that publish with WHIP: OBS, vMix and hardware encoders. The source gives you a server URL and a token to paste into the encoder. Needs the helper on this computer, which only passes the connection on: video goes straight from the encoder to this browser.${helper}`,
      whep: 'Play a stream from a WHEP server, such as MediaMTX, Cloudflare Stream or Millicast. Paste its WHEP URL, and a token if it needs one. No helper needed when the server accepts requests from web pages.',
      youtube: 'Play a YouTube video as a source. Paste its link and click Connect: a small window opens with YouTube\'s own player; click Start there and choose Allow. The studio receives just the video, with its own sound on its own fader (programme only, not your speakers), and nothing is downloaded. Keep the window open. Then play, pause, seek and loop it from the source card. Only use videos you have the rights to broadcast.'
        + (youTubeSupported() ? '' : ' Not available in this browser (Firefox): YouTube sources need Chrome or Edge.'),
      srt: `For SRT senders: OBS, vMix and hardware encoders. The helper on this computer listens on a UDP port and converts the stream to WebRTC for this page with ffmpeg, so any codec works. Adds about half a second to a second of delay and uses some CPU.${helper}`,
    }[kind];
    intro.replaceChildren(text);
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
      s.cfg.kind === 'whep' ? ' · WHEP' : s.cfg.kind === 'obs' ? ' · WHIP via helper' : s.cfg.kind === 'srt' ? ' · SRT via helper' : s.cfg.kind === 'youtube' ? ' · YouTube' : s.cfg.mode === 'relay' ? ' · invite link, relay' : ' · invite link, copy-paste',
      s.info?.device ? ` · ${s.info.device}` : '',
      s.pc && s.paused?.video ? el('span', { class: 'paused-chip' }, 'camera off') : null,
      s.pc && s.paused?.audio ? el('span', { class: 'paused-chip' }, 'mic off') : null);
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
    } else if (s.cfg.kind === 'youtube') {
      actions.push(...ytActions(s));
    } else if (s.cfg.kind === 'srt') {
      actions.push(...srtActions(s));
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

    const modeOpts = relayWorksRemotely(store.ws.settings.signalingUrl) && s.cfg.kind === 'peer'
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

  // A helper reached as localhost gives OBS on this computer a working URL, but a
  // phone needs this computer's network address instead.
  function phoneUrlField(s) {
    const url = sources.obsUrl(s.id);
    const lan = app.helperInfo?.lan?.[0];
    if (!url || !lan || !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) return [];
    return [field('Server for a phone or another computer', linkBox(url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)/, `$1${lan}`), 'Copy'))];
  }

  // Without a reachable helper, returns what to show instead of the card's
  // controls (why it's needed, install, check again); otherwise null.
  function helperGuard(...why) {
    const st = store.ws.settings;
    if (!st.signalingUrl) {
      const helper = app.helperOrigin;
      return [el('div', { class: 'note warn' }, ...why),
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
            'Downloads a small setup file. Run it once: it installs Node.js if needed, starts the helper in the background on this computer and again at every sign-in, and asks once for admin so your phone and OBS on this network can connect. Then click Check again. ',
            `On macOS or Linux: install Node.js and run node signaling-server/server.mjs --port ${HELPER_PORT}.`))];
    }
    if (app.relay?.state !== 'open') {
      return [el('div', { class: 'note warn' }, `Can't reach the helper at ${st.signalingUrl}. It may not be running, or it was removed.`),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn primary', onclick: downloadHelperInstaller }, 'Install helper (Windows)'),
          el('button', { class: 'btn', onclick: () => app.setupRelay() }, 'Check again'),
          el('button', { class: 'btn', title: 'Stop using this helper address', onclick: () => {
            st.signalingUrl = ''; store.save(); app.helperOrigin = null; app.setupRelay(); app.ui.emit('settings'); app.detectHelper();
          } }, 'Forget helper'))];
    }
    return null;
  }

  function obsActions(s, live) {
    const guard = helperGuard(
      'OBS sends its stream with an HTTP request, which a web page cannot receive. This needs the small optional helper (signaling-server/server.mjs) running next to the studio. ',
      'It only passes the connection details on; the video goes straight from OBS to this browser.');
    if (guard) return guard;
    return [
      el('div', { class: 'small muted' }, 'In OBS: Settings → Stream → Service: WHIP. Paste these two values:'),
      field('Server', linkBox(sources.obsUrl(s.id), 'Copy')),
      ...phoneUrlField(s),
      field('Bearer Token', linkBox(s.cfg.token, 'Copy')),
      el('div', { class: 'small muted' }, 'Use an H.264 encoder in OBS (Settings → Output), keyframe interval 1-2 s, up to about 8000 kb/s. Start Streaming in OBS and the source connects by itself.'),
      el('div', { class: 'btn-row' },
        live ? el('button', { class: 'btn', onclick: () => sources.disconnect(s.id) }, 'Disconnect')
          : s.state !== 'waiting' ? el('button', { class: 'btn primary', onclick: () => sources.reconnect(s.id) }, 'Accept encoder') : null,
        el('button', { class: 'btn sm', title: 'Invalidate the old token', onclick: () => { sources.update(s.id, { token: uid(12) }); } }, 'New token')),
    ];
  }

  // The address a phone or encoder on the home network can reach (not a
  // Hyper-V or WSL virtual adapter).
  function lanAddress() {
    const lan = app.helperInfo?.lan || [];
    return lan.find((a) => a.startsWith('192.168.')) || lan.find((a) => a.startsWith('10.')) || lan[0] || null;
  }

  // YouTube: a link and Connect, then the player's controls and a progress bar.
  function ytActions(s) {
    const url = text(s.cfg.ytUrl || '', (v) => sources.update(s.id, { ytUrl: v.trim() }), { type: 'url', placeholder: 'https://www.youtube.com/watch?v=…', autocomplete: 'off' });
    const connect = () => { errors.delete(s.id); sources.connectYouTube(s.id, url.value); };
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
    const st = s.yt?.status;
    const out = [field('YouTube link', el('div', { class: 'linkbox' }, url,
      el('button', { class: 'btn primary sm', onclick: connect }, s.stream ? 'Load' : 'Connect')))];
    if (s.cfg.ytUrl && !parseYouTube(s.cfg.ytUrl)) out.push(el('div', { class: 'card-detail bad' }, 'That isn\'t a YouTube video link.'));
    if (!youTubeSupported()) out.push(el('div', { class: 'note warn' }, 'YouTube sources aren\'t available in this browser. Open the studio in Chrome or Edge (version 132 or later) to use them.'));
    else if (!s.stream) {
      // How it works, before connecting and while waiting for Start.
      out.push(el('div', { class: 'yt-howto' },
        el('div', { class: 'yt-howto-title' }, kindIcon(['M4 5h16v12H4z', 'M8 21h8', 'M12 17v4']), 'A YouTube window will open'),
        el('ol', {},
          el('li', {}, 'Click ', el('b', {}, 'Connect'), ': a small window opens with YouTube\'s player.'),
          el('li', {}, 'In that window, click ', el('b', {}, 'Start'), ' and choose ', el('b', {}, 'Allow'), '.'),
          el('li', {}, 'Keep the window open while you use this source. It can sit behind other windows; closing it stops the video here.')),
        el('div', { class: 'small muted' }, 'Only the video is sent to the studio, with its sound going to the programme only. Allow pop-ups for this page if the browser blocks the window.')));
    }
    if (s.yt && !s.stream) {
      out.push(el('div', { class: 'btn-row' },
        el('button', { class: 'btn', onclick: () => sources.ytShow(s.id) }, 'Show YouTube window'),
        el('button', { class: 'btn', onclick: () => sources.disconnect(s.id) }, 'Close it')));
    }
    if (!s.stream || !st) return out;
    if (st.title) out.push(el('div', { class: 'yt-title', title: st.title }, st.title));
    // Progress bar: drag to seek; it follows playback while you are not dragging it.
    const bar = el('input', { type: 'range', class: 'yt-bar', min: 0, max: Math.max(1, Math.floor(st.duration)), step: 1, value: Math.floor(st.time), dataset: { sid: s.id }, 'aria-label': 'Playback position' });
    bar.addEventListener('input', () => { bar.dataset.dragging = '1'; time.textContent = `${fmtClock(Number(bar.value))} / ${fmtClock(st.duration)}`; });
    bar.addEventListener('change', () => { sources.ytCommand(s.id, 'seek', Number(bar.value)); delete bar.dataset.dragging; });
    const time = el('span', { class: 'yt-time mono small muted', dataset: { sid: s.id } }, `${fmtClock(st.time)} / ${fmtClock(st.duration)}`);
    const playing = st.state === 'playing' || st.state === 'buffering';
    out.push(el('div', { class: 'yt-progress' }, bar, time),
      el('div', { class: 'btn-row' },
        el('button', { class: `btn ${playing ? '' : 'primary'}`, onclick: () => sources.ytCommand(s.id, playing ? 'pause' : 'play') }, playing ? 'Pause' : 'Play'),
        el('button', { class: 'btn', title: 'Back to the start and play', onclick: () => sources.ytCommand(s.id, 'restart') }, 'Restart'),
        el('button', { class: `btn ${st.muted ? 'on' : ''}`, title: 'Silence this video in the programme', onclick: () => sources.ytCommand(s.id, 'mute', !st.muted) }, st.muted ? 'Unmute' : 'Mute'),
        check('Loop', !!s.cfg.ytLoop, (v) => sources.ytCommand(s.id, 'loop', v))),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn sm', onclick: () => sources.ytShow(s.id) }, 'Show YouTube window'),
        el('button', { class: 'btn sm', onclick: () => sources.disconnect(s.id) }, 'Disconnect')));
    return out;
  }

  function srtActions(s) {
    const guard = helperGuard(
      'A web page can\'t receive SRT. The helper on this computer listens for the SRT sender and converts the stream to WebRTC for this page with ffmpeg. ',
      'That adds about half a second to a second of delay.');
    if (guard) return guard;
    const info = app.helperInfo;
    if (info && !info.features?.includes('srt')) {
      return [el('div', { class: 'note warn' }, info.ffmpeg
        ? 'The ffmpeg on this computer is too old for SRT input. Run Install helper again, or update it with: winget upgrade Gyan.FFmpeg.Essentials'
        : 'SRT input needs ffmpeg on this computer. Run Install helper again; it installs ffmpeg.'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn primary', onclick: downloadHelperInstaller }, 'Install helper (Windows)'),
        el('button', { class: 'btn', onclick: () => app.detectHelper() }, 'Check again'))];
    }
    const listening = !!s.srt;
    const change = (patch) => { sources.update(s.id, patch); if (s.srt) sources.startSrt(s.id); };
    const port = num(s.cfg.srtPort, (v) => change({ srtPort: Math.round(v) }), { min: 1024, max: 65535, style: { width: '90px' } });
    const latency = num(s.cfg.srtLatency, (v) => change({ srtLatency: Math.round(v) }), { min: 20, max: 8000, step: 10, style: { width: '90px' } });
    const pass = text(s.cfg.srtPass || '', (v) => change({ srtPass: v.trim() }), { placeholder: 'Optional, 10-79 characters', autocomplete: 'off' });
    const lan = lanAddress();
    const st = s.srt?.info;
    const status = !listening ? 'Not listening.'
      : !st ? 'Starting…'
        : st.state === 'error' ? 'The helper could not listen on this port.'
          : `${st.state === 'listening' ? `Listening on UDP port ${st.port}` : 'Receiving'}${st.input?.video ? ` · input ${st.input.video}${st.input.audio ? ` + ${st.input.audio.toUpperCase()}` : ''}` : ''}${!st.encoder ? '' : /^pass-through/.test(st.encoder) ? ' · video passed through unchanged' : ` · converted with ${st.encoder}, up to ${st.height}p`}`;
    return [
      el('div', { class: 'small muted' }, 'In the SRT sender (OBS, vMix, a hardware encoder) choose mode Caller and enter:'),
      lan ? field('Address from a phone or another computer', linkBox(`srt://${lan}:${s.cfg.srtPort}`, 'Copy')) : null,
      field('Address from this computer', linkBox(`srt://127.0.0.1:${s.cfg.srtPort}`, 'Copy')),
      el('div', { class: 'btn-row' }, field('Port (UDP)', port), field('Latency (ms)', latency)),
      field('Passphrase', pass, 'If you set one, enter the same passphrase in the sender.'),
      field('Video', select({ convert: 'Convert (any sender, scaled to the programme)', passthrough: 'Pass through (lowest CPU, H.264 senders)' }, s.cfg.srtVideo || 'convert', (v) => change({ srtVideo: v })),
        (s.cfg.srtVideo || 'convert') === 'passthrough'
          ? 'The sender\'s video goes to the studio unchanged: almost no CPU. The sender must send H.264 without B-frames (OBS defaults are fine) at no more than the programme size. If the picture stutters or stays black, switch back to Convert.'
          : 'Works with any codec (HEVC, H.264). Uses the graphics chip when it can.'),
      el('div', { class: 'small muted' },
        `Use the same latency in the sender (${s.cfg.srtLatency} ms). `,
        `From outside your network, forward UDP port ${s.cfg.srtPort} on your router to this computer.`),
      el('div', { class: `card-detail ${st?.state === 'error' ? 'bad' : ''}` }, status),
      el('div', { class: 'btn-row' },
        listening ? el('button', { class: 'btn', onclick: () => sources.disconnect(s.id) }, 'Stop listening')
          : el('button', { class: 'btn primary', onclick: () => sources.startSrt(s.id) }, 'Start listening')),
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

  const renderAll = () => {
    renderIntro();
    const all = sources.all();
    empty.hidden = all.length > 0;
    cards.render(all);
  };
  sources.on('added', renderAll);
  sources.on('removed', renderAll);
  sources.on('reordered', renderAll);
  sources.on('change', (s) => cards.refresh(s));
  sources.on('yt', (s) => { // playback time and progress bar, without redrawing the card
    const st = s.yt?.status;
    if (!st) return;
    const bar = root.querySelector(`.yt-bar[data-sid="${s.id}"]`);
    if (bar?.dataset.dragging) return;
    if (bar) { bar.max = Math.max(1, Math.floor(st.duration)); bar.value = Math.floor(st.time); }
    const t = root.querySelector(`.yt-time[data-sid="${s.id}"]`);
    if (t) t.textContent = `${fmtClock(st.time)} / ${fmtClock(st.duration)}`;
  });
  sources.on('stats', (s) => {
    const slot = cards.cards.get(s.id)?.querySelector('.stats-slot');
    if (slot) slot.replaceChildren(statsFor(s));
  });
  switcher.on('change', () => { for (const s of sources.all()) cards.refresh(s); });
  app.ui.on('settings', renderAll);
  app.ui.on('relay', renderAll);
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

  mountHelperPanel(app, root);
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
