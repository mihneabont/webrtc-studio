// Top-bar pill showing whether the optional helper is running on this computer,
// with a panel to start it again or to install / update it.
import { el } from '../util.js';
import { HELPER_PORT, HELPER_VERSION, HELPER_PROTOCOL, downloadHelperInstaller } from './helper-install.js';

// Remembers (in this browser only) that a helper was seen here once, so a
// missing helper reads as "stopped" rather than "not installed".
const SEEN_KEY = 'webrtc-studio.helper-seen';
const seen = () => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage blocked */ } };

export function mountHelperStatus(app, root) {
  let open = false;
  let starting = false;
  const pill = el('button', { class: 'pill helper-pill', title: 'Helper on this computer (OBS, SRT, RTMP)', onclick: () => { open = !open; render(); } });
  const pop = el('div', { class: 'helper-pop', hidden: true });
  root.append(el('div', { class: 'helper-status' }, pill, pop));
  document.addEventListener('click', (e) => { if (open && !root.contains(e.target)) { open = false; render(); } });

  // Starting goes through the installer's webrtc-studio-helper: link; the
  // browser asks once whether to open it. Then look for the helper a few times.
  function start() {
    starting = true; render();
    const a = el('a', { href: `${HELPER_PROTOCOL}:start` });
    document.body.append(a); a.click(); a.remove();
    let tries = 0;
    const look = async () => {
      if (await app.detectHelper() || ++tries >= 6) { starting = false; render(); return; }
      setTimeout(look, 2000);
    };
    setTimeout(look, 1500);
  }

  function render() {
    const info = app.helperInfo;
    if (info) markSeen();
    const outdated = info && (info.version || 0) < HELPER_VERSION;
    const state = info ? (outdated ? 'update' : 'on') : starting ? 'starting' : app.helperChecked ? (seen() ? 'off' : 'none') : 'checking';
    const label = { on: 'Helper on', update: 'Helper: update', starting: 'Helper starting…', off: 'Helper off', none: 'No helper', checking: 'Helper…' }[state];
    pill.className = `pill helper-pill ${state === 'off' || state === 'update' ? 'warn' : ''}`;
    pill.replaceChildren(el('span', { class: `dot ${state === 'on' ? 'good' : state === 'off' || state === 'update' ? 'warn' : ''}` }), label);
    pop.hidden = !open;
    if (!open) return;

    const rows = [];
    if (info) {
      const feats = info.features || [];
      rows.push(el('div', { class: 'helper-title' }, outdated ? 'Running, but an older version' : 'Running'),
        el('div', { class: 'small muted' }, `At ${app.helperOrigin}${info.version ? ` · version ${info.version}` : ''}`),
        el('div', { class: 'helper-feats' },
          feat('OBS / WHIP input', feats.includes('whip-in')),
          feat('SRT input', feats.includes('srt'), info.ffmpeg ? 'needs a newer ffmpeg' : 'needs ffmpeg'),
          feat('RTMP output', feats.includes('rtmp'), 'needs ffmpeg')));
      if (outdated) rows.push(el('div', { class: 'note warn' }, 'Reinstall to get the newest helper (Windows asks for admin once, for the firewall).'));
    } else if (starting) {
      rows.push(el('div', { class: 'helper-title' }, 'Starting the helper…'),
        el('div', { class: 'small muted' }, 'If the browser asks to open "WebRTC Studio helper", allow it. If nothing happens, the helper was installed before it could be started from here: reinstall it once.'));
    } else {
      rows.push(el('div', { class: 'helper-title' }, seen() ? 'Not running' : 'Not found on this computer'),
        el('div', { class: 'small muted' }, `The helper is a small program on this computer (port ${HELPER_PORT}). OBS and SRT inputs and RTMP outputs need it; everything else works without it.`));
    }
    const btns = [];
    if (!info) btns.push(el('button', { class: 'btn primary', disabled: starting, onclick: start }, 'Start helper'));
    btns.push(el('button', { class: `btn ${info && !outdated ? '' : info ? 'primary' : ''}`, onclick: downloadHelperInstaller }, info ? (outdated ? 'Update helper' : 'Reinstall helper') : 'Install helper (Windows)'));
    btns.push(el('button', { class: 'btn', onclick: async (e) => { e.target.textContent = 'Looking…'; await app.detectHelper(); render(); } }, 'Check again'));
    rows.push(el('div', { class: 'btn-row' }, ...btns),
      el('div', { class: 'small muted' }, 'Install / update downloads a setup file: run it. It installs Node.js and ffmpeg if needed and starts the helper at every sign-in. Run it with /uninstall to remove the helper. macOS / Linux: node signaling-server/server.mjs --port ' + HELPER_PORT + '.'));
    pop.replaceChildren(...rows);
  }

  function feat(name, ok, why) {
    return el('div', { class: `helper-feat ${ok ? 'ok' : ''}` }, el('span', { class: `dot ${ok ? 'good' : ''}` }), name, ok ? '' : el('span', { class: 'muted' }, ` (${why || 'not available'})`));
  }

  app.ui.on('helper', render);
  render();
}
