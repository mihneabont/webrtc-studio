// Settings → Studio Mixer: connect this studio to a mixer (on this computer or
// another one), see its state, pause or forget it, or install one.
import { el } from '../util.js';
import { MIXER_PORT, downloadMixerInstaller } from './mixer-install.js';
import { field, text, linkBox } from './forms.js';

export function mountMixerPanel(app, root) {
  const mixer = app.mixer;
  const box = el('div', { class: 'card', 'data-section': 'mixer' });
  let local = null; // /api/info of a mixer on this computer, if one answers
  let note = '';
  let busy = false;
  const addrIn = text('', () => {}, { placeholder: 'e.g. 192.168.1.20 or https://mixer.example.com' });
  const codeIn = el('input', { type: 'text', placeholder: '6-digit code', inputMode: 'numeric', autocomplete: 'off', style: { width: '120px' } });

  async function probeLocal() {
    try { local = await mixer.probe(`http://localhost:${MIXER_PORT}`); } catch { local = null; }
    render();
  }

  async function run(fn) {
    busy = true; note = ''; render();
    try { await fn(); } catch (e) { note = e.message; }
    busy = false; render();
  }

  function render() {
    const cfg = mixer.cfg;
    const s = mixer.status;
    const paired = !!(cfg.url && cfg.token);
    const state = !paired ? ['', 'Not connected']
      : !cfg.on ? ['warn', 'Paused']
        : mixer.state === 'open' ? (s?.engineError ? ['bad', 'Connected, but the mixer has a problem'] : ['good', 'Connected'])
          : mixer.state === 'connecting' ? ['warn', 'Connecting…'] : ['bad', 'Not reachable'];
    const parts = [
      el('div', { class: 'card-head' }, el('span', { class: `dot ${state[0]}` }), el('span', { class: 'card-title' }, `Studio Mixer: ${state[1]}`)),
      el('div', { class: 'small muted' }, 'Optional. A Studio Mixer is a program that does the mixing, encoding and sending on a computer of your choice (this one, or another one, at home or on a server). '
        + 'With it, the studio also takes SRT and RTMP senders and sends RTMP, SRT, WHIP and Twitch outputs, and keeps streaming when this tab is closed. '
        + 'This page stays the control room: same screens and buttons, with light preview video from the mixer. Without a mixer, everything runs in this browser as before.'),
    ];
    if (paired) {
      parts.push(el('div', { class: 'statline' },
        el('span', {}, el('em', {}, 'mixer'), cfg.name || '–'),
        el('span', {}, el('em', {}, 'address'), cfg.url),
        mixer.info?.public && mixer.info.public !== cfg.url ? el('span', {}, el('em', {}, 'https'), mixer.info.public) : null,
        mixer.info?.version ? el('span', {}, el('em', {}, 'version'), String(mixer.info.version)) : null,
        s?.encoder ? el('span', {}, el('em', {}, 'encoder'), s.encoder) : null,
        s ? el('span', {}, el('em', {}, 'programme'), `${s.format.width}×${s.format.height} · ${s.fps ?? '–'} fps · ${s.kbps} kb/s`) : null,
        s ? el('span', {}, el('em', {}, 'control rooms'), String(s.clients)) : null));
      const tun = mixer.info?.tunnel;
      if (mixer.info?.public && mixer.info.public !== cfg.url) {
        parts.push(field('https address, to reach this mixer from another computer or a phone', linkBox(mixer.info.public, 'Copy'),
          'It changes when the mixer restarts. To pair another studio, use it with the code on the mixer\'s page.'));
      } else if (tun && (tun.state === 'error' || tun.state === 'off') && !/^https:/.test(cfg.url)) {
        parts.push(el('div', { class: 'small muted' }, `No https address for this mixer${tun.error ? ` (${tun.error})` : ''}. It is only needed to reach the mixer from another computer or a phone; run the mixer setup again to add it.`));
      }
      if (mixer.state === 'error' && cfg.on) parts.push(el('div', { class: 'note warn' }, mixer.error || 'Not reachable.'));
      if (mixer.active && mixer.previewError) parts.push(el('div', { class: 'note warn' }, mixer.previewError));
      if (s?.engineError) parts.push(el('div', { class: 'note bad' }, `The mixer could not start its mixing engine: ${s.engineError}`));
      if (s?.mediamtx && !s.mediamtx.running) parts.push(el('div', { class: 'note bad' }, `The mixer's media server is not running${s.mediamtx.error ? `: ${s.mediamtx.error}` : ''}.`));
      parts.push(el('div', { class: 'btn-row' },
        cfg.on ? el('button', { class: 'btn', title: 'Run everything in this browser again; the mixer stays paired', onclick: () => mixer.pause() }, 'Use the browser only')
          : el('button', { class: 'btn primary', onclick: () => mixer.resume() }, 'Use the mixer'),
        cfg.on && mixer.state !== 'open' ? el('button', { class: 'btn', onclick: () => mixer.connect() }, 'Try again') : null,
        el('button', { class: 'btn danger sm', onclick: () => {
          if (!confirm('Forget this mixer? To use it again, pair it again.')) return;
          mixer.forget(); render();
        } }, 'Forget mixer')));
      parts.push(el('div', { class: 'small muted' }, 'Outputs that run on the mixer keep running when this page is closed or paused. Stop them first if you want them off.'));
    } else {
      if (local) {
        parts.push(el('div', { class: 'note' }, `A Studio Mixer is running on this computer${local.name ? ` ("${local.name}")` : ''}.`),
          el('div', { class: 'btn-row' }, el('button', { class: 'btn primary', disabled: busy, onclick: () => run(() => mixer.pairLocal(`http://localhost:${MIXER_PORT}`)) }, 'Connect to it')),
          el('div', { class: 'small muted' }, 'A small window from the mixer opens and asks you to confirm.'));
      } else {
        parts.push(el('div', { class: 'btn-row' },
          el('button', { class: 'btn primary', onclick: downloadMixerInstaller }, 'Install the mixer on this computer (Windows)'),
          el('button', { class: 'btn sm', onclick: probeLocal }, 'Check again')),
        el('div', { class: 'small muted' }, 'Downloads a setup file. Run it: it installs the mixer and everything it needs, starts it in the background now and at every sign-in, and asks once for admin to open its ports in the firewall. Then come back here and click Check again.'));
      }
      parts.push(el('div', { class: 'section-title' }, 'Mixer on another computer'),
        field('Mixer address', addrIn, 'Its https address (https://….trycloudflare.com). Open the mixer\'s page on that computer (http://localhost:8788) to see it and the pairing code. A plain http network address only works when this page itself is opened over http.'),
        el('div', { class: 'btn-row' }, codeIn,
          el('button', { class: 'btn', disabled: busy, onclick: () => run(() => mixer.pairWithCode(addrIn.value, codeIn.value.trim())) }, busy ? 'Pairing…' : 'Pair')));
    }
    if (note) parts.push(el('div', { class: 'note warn' }, note));
    box.replaceChildren(...parts);
  }

  root.append(el('div', { class: 'section-title' }, 'Studio Mixer'), box);
  mixer.on('state', render);
  let last = '';
  mixer.on('status', (s) => { // redraw only when something shown changes
    const sig = JSON.stringify([s.encoder, s.format, s.fps, s.kbps, s.clients, s.engineError, s.mediamtx]);
    if (sig !== last) { last = sig; render(); }
  });
  render();
  if (!mixer.cfg.token) probeLocal();
  setInterval(() => { if (!mixer.cfg.token && !document.hidden) probeLocal(); }, 10000);
}
