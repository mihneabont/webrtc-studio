// Settings → Helper: is the optional helper running on this computer, what it
// can do, and buttons to turn it on or off, check again, or (re)install it.
import { el } from '../util.js';
import { HELPER_PORT, HELPER_VERSION, downloadHelperInstaller } from './helper-install.js';

export function mountHelperPanel(app, root) {
  const box = el('div', { class: 'card', 'data-section': 'helper' });
  let busy = null; // 'starting' | 'stopping' | null
  let note = '';

  const time = (t) => (t ? new Date(t).toLocaleTimeString([], { hour12: false }) : '–');
  const yes = (ok, label, why) => el('span', { class: ok ? '' : 'muted', title: ok ? '' : why || '' }, `${ok ? '✓' : '✗'} ${label}`);

  async function turnOn() {
    busy = 'starting'; note = ''; render();
    const ok = await app.startHelper();
    busy = null;
    note = ok ? '' : 'It did not start. If the browser asked to open "WebRTC Studio helper", allow it and click Turn on again. '
      + 'A helper installed before this button existed needs one reinstall (Install helper below) before it can be turned on from here.';
    render();
  }
  async function turnOff() {
    busy = 'stopping'; note = ''; render();
    await app.stopHelper();
    busy = null; render();
  }

  function render() {
    const h = app.helperInfo;
    const version = h?.version || 0;
    const old = h && version < HELPER_VERSION;
    const feats = new Set(h?.features || []);
    const state = busy === 'starting' ? ['warn', 'Starting…'] : busy === 'stopping' ? ['warn', 'Turning off…']
      : !h ? ['bad', 'Not running']
        : old ? ['warn', 'Running, but an update is available'] : ['good', 'Running'];
    const parts = [
      el('div', { class: 'card-head' }, el('span', { class: `dot ${state[0]}` }), el('span', { class: 'card-title' }, `Helper: ${state[1]}`)),
      el('div', { class: 'small muted' }, 'The optional helper runs on this computer. It lets OBS and SRT senders into the studio and sends RTMP outputs; everything else works without it.'),
    ];
    if (h) {
      parts.push(
        el('div', { class: 'statline' },
          el('span', {}, el('em', {}, 'address'), app.helperOrigin),
          h.lan?.length ? el('span', {}, el('em', {}, 'network'), h.lan.join(', ')) : null,
          el('span', {}, el('em', {}, 'version'), version ? String(version) : 'before 4'),
          h.startedAt ? el('span', {}, el('em', {}, 'running since'), new Date(h.startedAt).toLocaleString([], { hour12: false })) : null),
        el('div', { class: 'statline' },
          yes(feats.has('whip-in'), 'OBS / WHIP input'),
          yes(feats.has('srt'), 'SRT input', h.ffmpeg ? 'This ffmpeg has no SRT/WebRTC support (needs ffmpeg 8 or later)' : 'ffmpeg is not installed'),
          yes(feats.has('rtmp'), 'RTMP output', 'ffmpeg is not installed')),
      );
      if (old) parts.push(el('div', { class: 'note warn' }, 'This helper is older than the studio page. Reinstall it to get the latest features and fixes; it takes a minute and keeps working the same way.'));
    }
    if (note) parts.push(el('div', { class: 'note warn' }, note));
    const btns = [];
    if (h && !busy) btns.push(el('button', { class: 'btn', onclick: turnOff, title: 'Stops it until you turn it on again or sign in to Windows again' }, 'Turn off'));
    if (!h && !busy) btns.push(el('button', { class: 'btn primary', onclick: turnOn }, 'Turn on'));
    btns.push(el('button', { class: `btn ${old || (!h && note) ? 'primary' : ''}`, onclick: downloadHelperInstaller }, h ? (old ? 'Update helper (Windows)' : 'Reinstall helper (Windows)') : 'Install helper (Windows)'));
    btns.push(el('button', { class: 'btn sm', onclick: () => app.detectHelper() }, 'Check now'));
    parts.push(el('div', { class: 'btn-row' }, ...btns));
    parts.push(el('div', { class: 'small muted' },
      `Checked ${time(app.helperCheckedAt)} (every few seconds). The installer downloads a setup file: run it, and it installs or updates the helper and starts it on port ${HELPER_PORT}. `,
      'Run that file with /uninstall to remove the helper. On macOS or Linux start it yourself: node signaling-server/server.mjs --port 8788.'));
    box.replaceChildren(...parts);
  }

  root.append(el('div', { class: 'section-title' }, 'Helper on this computer'), box);
  app.ui.on('helper', render);
  render();
}
