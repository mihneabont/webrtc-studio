// Outputs tab: programme format, receivers, WHIP and Twitch outputs.
import { el, fmtKbps, fmtRes, fmtMs, relayWorksRemotely } from '../util.js';
import { OUTPUT_STATES, TWITCH, defaultKbps } from '../outputs.js';
import { sealSecret, openSecret } from '../store.js';
import { field, text, num, select, check, linkBox, statLine, CardList } from './forms.js';

const RESOLUTIONS = { '1920x1080': '1920×1080 (1080p)', '1280x720': '1280×720 (720p)', '960x540': '960×540', '854x480': '854×480 (480p)', '640x360': '640×360' };
const FPS = { 24: '24', 25: '25', 30: '30', 50: '50', 60: '60' };
const CODECS = { auto: 'Browser default', h264: 'H.264', vp8: 'VP8', vp9: 'VP9', av1: 'AV1' };

export function mountOutputsTab(app, root, setBadge) {
  const { outputs, compositor, store } = app;
  const fmt = store.ws.settings.format;
  const drafts = new Map();
  const unlocked = new Set();

  // Plain-saved keys are available immediately.
  for (const o of outputs.all()) if (o.cfg.secret?.mode === 'plain') { o.token = o.cfg.secret.data; unlocked.add(o.id); }

  const setFormat = (patch) => {
    if (outputs.liveCount() && !confirm('Outputs are live. Changing the programme format mid-stream can make receivers or ingest platforms glitch or drop the stream. Change anyway?')) { renderFormat(); return; }
    Object.assign(fmt, patch);
    store.save();
    compositor.applyFormat();
    outputs.applyEncodingAll();
    renderFormat();
    cards.render(outputs.all());
  };
  const formatBox = el('div', { class: 'card' });
  const mixerOn = () => !!outputs.remote;
  function renderFormat() {
    const st = store.ws.settings;
    formatBox.replaceChildren(
      el('div', { class: 'grid2' },
        field('Resolution', select(RESOLUTIONS, `${fmt.width}x${fmt.height}`, (v) => { const [w, h] = v.split('x').map(Number); setFormat({ width: w, height: h }); })),
        field('Frame rate', select(FPS, fmt.fps, (v) => setFormat({ fps: Number(v) })))),
      mixerOn() ? field('Programme bitrate on the mixer (kb/s)', num(st.mixerKbps || defaultKbps(fmt.height), (v) => {
        if (outputs.liveCount() && !confirm('Outputs are live. A new bitrate restarts the mixer\'s encoder, which interrupts every output for a moment. Change anyway?')) { renderFormat(); return; }
        st.mixerKbps = Math.max(500, Math.min(50000, v)); store.save(); renderFormat();
      }, { min: 500, step: 500 }), `Suggested for ${fmt.height}p: ${defaultKbps(fmt.height)} kb/s. The mixer encodes the programme once, and every RTMP, SRT, WHIP and Twitch output sends that same stream.`) : null,
      el('div', { class: 'small muted' }, mixerOn()
        ? 'The Studio Mixer renders the programme at this size and rate. Changing it restarts the mixer\'s encoder.'
        : 'The programme is rendered at this size and rate and sent unchanged to every output. Each output encodes separately, so every extra output costs CPU.'));
  }
  renderFormat();

  const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const srtAdd = el('button', { class: 'btn sm', onclick: () => { outputs.add({ kind: 'srt' }); cards.render(outputs.all()); } }, '+ SRT');
  const addNote = el('div', { class: 'small muted' });
  root.append(
    el('div', { class: 'section-title' }, 'Programme format'), formatBox,
    el('div', { class: 'section-title' }, 'Add output'),
    el('div', { class: 'card' }, el('div', { class: 'btn-row' },
      el('button', { class: 'btn sm', onclick: () => { outputs.add({ kind: 'peer' }); cards.render(outputs.all()); } }, '+ Browser receiver'),
      el('button', { class: 'btn sm', onclick: () => { outputs.add({ kind: 'whip' }); cards.render(outputs.all()); } }, '+ WHIP endpoint'),
      el('button', { class: 'btn sm', onclick: () => { outputs.add({ kind: 'twitch' }); cards.render(outputs.all()); } }, '+ Twitch'),
      el('button', { class: 'btn sm', onclick: () => { outputs.add({ kind: 'rtmp' }); cards.render(outputs.all()); } }, '+ RTMP'),
      srtAdd),
      addNote),
    el('div', { class: 'section-title' }, 'Outputs'), list);

  const cards = new CardList(list, (o) => {
    const remote = outputs.remoteKind(o);
    // The mixer keeps the key it was given, so another browser can start the output without it.
    const keyOnMixer = remote && !o.token && app.mixer.status?.outputs?.[o.id]?.hasKey;
    const live = remote ? ['connecting', 'live', 'unstable'].includes(o.state) : !!o.pc;
    const kindLabel = remote ? `${{ twitch: 'Twitch', whip: 'WHIP', rtmp: 'RTMP', srt: 'SRT' }[o.cfg.kind]} from the mixer`
      : o.cfg.kind === 'srt' ? 'SRT (needs the mixer)'
        : o.cfg.kind === 'twitch' ? 'Twitch (WHIP)' : o.cfg.kind === 'whip' ? 'WHIP' : o.cfg.kind === 'rtmp' ? 'RTMP (needs the mixer)' : `Browser receiver · ${o.cfg.mode === 'relay' ? 'relay' : 'copy-paste'}`;
    const head = el('div', { class: 'card-head' }, el('span', { class: `dot ${o.state}` }), el('span', { class: 'card-title' }, o.cfg.name),
      o.state === 'live' ? el('span', { class: 'tchip pgm' }, 'ON AIR') : null);
    const state = el('div', { class: 'card-state' }, `${OUTPUT_STATES[o.state] || o.state} · ${kindLabel}`);
    const detail = el('div', { class: `card-detail ${o.state === 'failed' ? 'bad' : ''}` }, o.detail || '');
    const stats = el('div', { class: 'stats-slot' }, statsFor(o));
    const parts = [head, state, detail, stats];

    const bitrate = remote ? el('div', { class: 'small muted' }, 'Bitrate: the mixer\'s programme bitrate, set under Programme format.') : field('Max video bitrate (kb/s)', num(o.cfg.maxKbps, (v) => outputs.update(o.id, { maxKbps: Math.max(200, Math.min(o.cfg.kind === 'twitch' ? TWITCH.maxKbps : 50000, v)) }), { min: 200, step: 100 }),
      o.cfg.kind === 'twitch' ? `Twitch guidance is up to 6000 kb/s; values up to ${TWITCH.maxKbps} are allowed here. Applies live.`
        : `Suggested for ${fmt.height}p: ${defaultKbps(fmt.height)} kb/s. ${o.cfg.kind === 'rtmp' ? 'Applies on next start.' : 'Applies live.'}`);

    if (o.cfg.kind === 'peer') {
      if (o.cfg.mode === 'manual') {
        if (o.state === 'invited' && o.invite) {
          const ta = el('textarea', { rows: 3, placeholder: 'Paste the reply code from the receiver page' });
          ta.value = drafts.get(o.id) || '';
          ta.addEventListener('input', () => drafts.set(o.id, ta.value));
          const accept = el('button', { class: 'btn primary', onclick: async () => {
            try { await outputs.acceptAnswer(o.id, ta.value); drafts.delete(o.id); } catch (e) { o.detail = e.message; }
            cards.refresh(o);
          } }, 'Connect');
          ta.addEventListener('paste', () => setTimeout(() => accept.click(), 50));
          parts.push(el('div', { class: 'small muted' }, '1. Open this link on the receiving device:'), linkBox(o.invite.link, 'Copy link'),
            el('div', { class: 'small muted' }, '2. Paste the reply code it shows:'), ta, el('div', { class: 'btn-row' }, accept, el('button', { class: 'btn', onclick: () => outputs.stop(o.id) }, 'Cancel')));
        } else {
          parts.push(el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', onclick: () => outputs.start(o.id) }, live ? 'Reconnect (new invite)' : 'Start (create invite)'),
            live ? el('button', { class: 'btn danger', onclick: () => outputs.stop(o.id) }, 'Stop') : null));
        }
      } else {
        parts.push(el('div', { class: 'small muted' }, 'Receiver link (reusable):'), linkBox(outputs.relayLink(o.id), 'Copy link'),
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', onclick: () => outputs.start(o.id) }, ['idle', 'stopped'].includes(o.state) ? 'Start' : 'Reconnect'),
            o.state !== 'idle' && o.state !== 'stopped' ? el('button', { class: 'btn danger', onclick: () => outputs.stop(o.id) }, 'Stop') : null));
      }
      parts.push(el('details', {}, el('summary', {}, 'Output settings'), el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        field('Name', text(o.cfg.name, (v) => outputs.update(o.id, { name: v }))), bitrate,
        field('Video codec', select(CODECS, o.cfg.codec, (v) => outputs.update(o.id, { codec: v })), 'Applies on next start.'),
        relayWorksRemotely(store.ws.settings.signalingUrl) ? field('Signaling', select({ manual: 'Copy-paste codes', relay: 'Signaling relay' }, o.cfg.mode, (v) => { outputs.stop(o.id, true); outputs.update(o.id, { mode: v }); cards.refresh(o); })) : null,
        removeBtn(o))));
      return el('div', { class: `card ${o.state === 'live' ? 'live' : o.state === 'failed' ? 'failed' : ''}` }, ...parts);
    }

    if (o.cfg.kind === 'srt') {
      if (!remote) parts.push(needsMixer('A web page can\'t send SRT. The Studio Mixer sends it for you.'));
      const url = text(o.cfg.url, (v) => outputs.update(o.id, { url: v.trim() }, { silent: true }), { placeholder: 'srt://host:port?streamid=…' });
      parts.push(field('SRT address', url, 'The full srt:// address from the receiving server, including streamid or passphrase if it needs them. The mixer connects as the caller.'));
      if (remote) {
        parts.push(el('div', { class: 'btn-row' },
          el('button', { class: `btn ${live ? '' : 'live'}`, onclick: () => outputs.start(o.id) }, live ? 'Restart' : 'Start'),
          live || o.state === 'failed' ? el('button', { class: 'btn danger', onclick: () => outputs.stop(o.id) }, 'Stop') : null));
      }
      parts.push(el('details', {}, el('summary', {}, 'Output settings'), el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        field('Name', text(o.cfg.name, (v) => outputs.update(o.id, { name: v }))), removeBtn(o))));
      return el('div', { class: `card ${o.state === 'live' ? 'live' : o.state === 'failed' ? 'failed' : ''}` }, ...parts);
    }

    if (o.cfg.kind === 'rtmp') {
      if (!remote) parts.push(needsMixer('A web page can\'t send RTMP (YouTube, Twitch, Facebook and most platforms). The Studio Mixer sends it for you.'));
      const url = text(o.cfg.url, (v) => outputs.update(o.id, { url: v.trim() }, { silent: true }), { placeholder: 'rtmp://live.twitch.tv/app' });
      const keyIn = el('input', { type: 'password', value: o.token || '', placeholder: keyOnMixer ? 'Saved on the mixer' : 'Stream key', autocomplete: 'off' });
      keyIn.addEventListener('change', () => { o.token = keyIn.value.trim(); });
      parts.push(field('Server URL', url, 'From the platform\'s stream settings, e.g. rtmp://a.rtmp.youtube.com/live2 or rtmp://live.twitch.tv/app. rtmps:// works too.'),
        field('Stream key', keyIn), secretControls(o, keyIn));
      if (remote) {
        parts.push(el('div', { class: 'btn-row' },
          el('button', { class: `btn ${live ? '' : 'live'}`, onclick: () => { o.token = keyIn.value.trim(); outputs.start(o.id); } }, live ? 'Restart' : 'Start broadcast'),
          live || o.state === 'failed' ? el('button', { class: 'btn danger', onclick: () => outputs.stop(o.id) }, 'Stop broadcast') : null));
      }
      parts.push(el('details', {}, el('summary', {}, 'Output settings'), el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        field('Name', text(o.cfg.name, (v) => outputs.update(o.id, { name: v }))), bitrate,
        el('div', { class: 'small muted' }, 'Video: the mixer\'s H.264 programme, passed through. Audio: AAC 160 kb/s.'),
        check('Reconnect automatically after failures', o.cfg.autoReconnect, (v) => outputs.update(o.id, { autoReconnect: v })),
        removeBtn(o))));
      return el('div', { class: `card ${o.state === 'live' ? 'live' : o.state === 'failed' ? 'failed' : ''}` }, ...parts);
    }

    // WHIP / Twitch
    const twitch = o.cfg.kind === 'twitch';
    if (twitch && remote) {
      parts.push(el('div', { class: 'small muted' }, 'The mixer sends to Twitch over RTMPS (Twitch\'s documented ingest), so only the stream key is needed.'));
    } else if (twitch) {
      parts.push(el('div', { class: 'note warn' },
        'Unverified integration. Twitch\'s official developer documentation describes RTMP ingest only and does not document WHIP. ',
        'This output uses the WebRTC endpoint Twitch announced in 2023 (also used by OBS), with your stream key as the Bearer token, H.264 video and Opus audio. ',
        'If Twitch has changed or withdrawn that endpoint, or blocks browser requests (CORS), the error below says so.'));
      const probs = outputs.formatProblems(o);
      if (probs.length) parts.push(el('div', { class: 'note warn' }, probs.join(' ')));
    }
    const url = text(o.cfg.url, (v) => outputs.update(o.id, { url: v.trim() }, { silent: true }), { type: 'url', placeholder: 'https://ingest.example.com/whip/…' });
    const keyIn = el('input', { type: 'password', value: o.token || '', placeholder: keyOnMixer ? 'Saved on the mixer' : twitch ? 'Twitch stream key (live_…)' : 'Bearer token (optional)', autocomplete: 'off' });
    keyIn.addEventListener('change', () => { o.token = keyIn.value.trim(); });
    parts.push(twitch && remote ? null : field(twitch ? 'Ingest URL' : 'WHIP URL', url), field(twitch ? 'Stream key' : 'Bearer token', keyIn));
    parts.push(secretControls(o, keyIn));
    parts.push(el('div', { class: 'btn-row' },
      el('button', { class: `btn ${live ? '' : 'live'}`, onclick: () => { o.token = keyIn.value.trim(); outputs.start(o.id); } }, live ? 'Reconnect' : twitch ? 'Start broadcast' : 'Start'),
      live || o.state === 'failed' ? el('button', { class: 'btn danger', onclick: () => outputs.stop(o.id) }, twitch ? 'Stop broadcast' : 'Stop') : null));
    parts.push(el('details', {}, el('summary', {}, 'Output settings'), el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      field('Name', text(o.cfg.name, (v) => outputs.update(o.id, { name: v }))), bitrate,
      remote ? el('div', { class: 'small muted' }, `Video: the mixer's H.264 programme, passed through. Audio: ${twitch ? 'AAC' : 'Opus'}.`)
        : twitch ? el('div', { class: 'small muted' }, 'Video codec: H.264 (required by Twitch). Audio: Opus.')
        : field('Video codec', select(CODECS, o.cfg.codec, (v) => outputs.update(o.id, { codec: v })), 'Many WHIP servers require H.264. Applies on next start.'),
      check('Reconnect automatically after failures', o.cfg.autoReconnect, (v) => outputs.update(o.id, { autoReconnect: v })),
      removeBtn(o))));
    return el('div', { class: `card ${o.state === 'live' ? 'live' : o.state === 'failed' ? 'failed' : ''}` }, ...parts);
  });

  function needsMixer(why) {
    return el('div', { class: 'note warn' }, why, ' ',
      el('button', { class: 'btn sm primary', onclick: () => app.ui.showTab('settings', 'mixer') }, 'Set up the Studio Mixer'));
  }

  function secretControls(o, keyIn) {
    const box = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    if (o.cfg.secret?.mode === 'enc' && !unlocked.has(o.id)) {
      const pass = el('input', { type: 'password', placeholder: 'Passphrase' });
      const msg = el('span', { class: 'small muted' });
      box.append(el('div', { class: 'small muted' }, 'A saved, encrypted key exists for this output.'),
        el('div', { class: 'linkbox' }, pass, el('button', { class: 'btn sm', onclick: async () => {
          try { o.token = await openSecret(o.cfg.secret, pass.value); unlocked.add(o.id); cards.refresh(o); } catch (e) { msg.textContent = e.message; }
        } }, 'Unlock')), msg);
      return box;
    }
    const mode = o.cfg.remember || 'none';
    const pass = el('input', { type: 'password', placeholder: 'Passphrase (not stored)' });
    const status = el('span', { class: 'small muted' }, o.cfg.secret ? (o.cfg.secret.mode === 'enc' ? 'Key saved, encrypted.' : 'Key saved in plain text in this browser.') : 'Key is kept for this session only.');
    const sel = select({ none: 'Don\'t save the key', enc: 'Save encrypted with a passphrase', plain: 'Save unencrypted on this device' }, mode, (v) => {
      outputs.update(o.id, { remember: v });
      if (v === 'none') { delete o.cfg.secret; store.save(); }
      cards.refresh(o);
    });
    box.append(field('Remember key', sel));
    if (mode !== 'none') {
      box.append(el('div', { class: 'linkbox' }, mode === 'enc' ? pass : null, el('button', { class: 'btn sm', onclick: async () => {
        const key = keyIn.value.trim();
        if (!key) { status.textContent = 'Enter the key first.'; return; }
        if (mode === 'enc' && pass.value.length < 6) { status.textContent = 'Use a passphrase of at least 6 characters.'; return; }
        o.token = key;
        o.cfg.secret = await sealSecret(key, mode === 'enc' ? pass.value : '');
        store.save(); unlocked.add(o.id);
        status.textContent = mode === 'enc' ? 'Saved, encrypted (AES-GCM, PBKDF2).' : 'Saved in plain text.';
      } }, 'Save key')));
      if (mode === 'plain') box.append(el('div', { class: 'small muted' }, 'Anyone with access to this browser profile can read a plain-text key.'));
    }
    box.append(status);
    return box;
  }

  function removeBtn(o) {
    return el('div', { class: 'btn-row' }, el('button', { class: 'btn danger sm', onclick: () => {
      if (o.state === 'live' && !confirm(`"${o.cfg.name}" is live. Stop and remove it?`)) return;
      if (o.state !== 'live' && !confirm(`Remove "${o.cfg.name}"?`)) return;
      outputs.remove(o.id); cards.render(outputs.all());
    } }, 'Remove output'));
  }

  function statsFor(o) {
    const st = o.stats;
    if (!st) return '';
    const v = st.out.video, a = st.out.audio, p = st.pair;
    return statLine([
      ['res', v ? fmtRes(v.width, v.height) : null], ['fps', v?.fps !== undefined ? Math.round(v.fps) : null],
      ['video', v ? fmtKbps(v.kbps) : null], ['audio', a ? fmtKbps(a.kbps) : null], ['target', v?.target ? fmtKbps(v.target) : null],
      ['available', p?.availOut ? fmtKbps(p.availOut) : null], ['codec', [v?.codec, a?.codec].filter(Boolean).join('/')],
      ['encoder', v?.encoder], ['limited by', v?.limitation && v.limitation !== 'none' ? v.limitation : null],
      ['rtt', p?.rtt !== undefined ? fmtMs(p.rtt) : v?.rtt !== undefined ? fmtMs(v.rtt) : null],
      ['loss', v?.loss !== undefined ? `${(v.loss * 100).toFixed(1)}%` : null], ['keyframes', v?.keyframes], ['PLI', v?.pli],
      ['path', p ? `${p.local} → ${p.remote}` : null], ['health', st.health],
    ]);
  }

  const badge = () => setBadge(outputs.liveCount());
  function renderMode() {
    addNote.textContent = mixerOn()
      ? 'A browser receiver is any device that opens the receiver link (receive.html); it gets the programme back from the mixer. RTMP, SRT, WHIP and Twitch are sent by the Studio Mixer.'
      : 'A browser receiver is any device that opens the receiver link (receive.html). WHIP sends to any WebRTC ingest server that implements RFC 9725. RTMP and SRT need the Studio Mixer (Settings, Studio Mixer).';
  }
  app.mixer?.on('state', () => { renderMode(); renderFormat(); cards.render(outputs.all()); });
  renderMode();
  outputs.on('change', (o) => { cards.refresh(o); badge(); });
  outputs.on('removed', () => { cards.render(outputs.all()); badge(); });
  outputs.on('stats', (o) => { const slot = cards.cards.get(o.id)?.querySelector('.stats-slot'); if (slot) slot.replaceChildren(statsFor(o)); });
  app.ui.on('settings', () => cards.render(outputs.all()));
  cards.render(outputs.all());
  badge();
}
