// Contributor page: captures a camera/microphone (or screen) and sends it to
// the studio over WebRTC. Signaling: the invite link carries the studio's
// offer and this page produces a reply code, or the optional relay does it.
import { $, el, copyText, fmtKbps, fmtRes, fmtMs, sleep } from './util.js';
import { decodeSignal, encodeSignal } from './codec.js';
import { rtcConfig, waitForIceGathering, StatsSampler } from './rtc.js';
import { Relay } from './relay.js';
import { PublicRelay } from './meet.js';

const params = new URLSearchParams(location.hash.slice(1));
const offerCode = params.get('c');
// A reusable link: through a signaling relay (sig=...) or the public meeting points (m=1, key=...).
const relayCfg = params.get('sig') || params.get('m')
  ? { sig: params.get('sig'), meet: params.get('m') === '1', key: params.get('key'), room: params.get('room'), slot: params.get('slot'), name: params.get('name') }
  : null;
let studioBoot = null; // which studio page load our connection belongs to

let local = null;     // MediaStream being sent
let pc = null, sampler = null, relay = null, joined = false, wakeLock = null, ctl = null;
let offerMsg = null;

const ui = {
  dot: $('#dot'), state: $('#state'), detail: $('#detail'), self: $('#self'), frame: $('#frame'), tally: $('#tally'),
  vsel: $('#vsel'), asel: $('#asel'), qsel: $('#qsel'), bitrate: $('#bitrate'), go: $('#go'), stop: $('#stop'),
  replyCard: $('#replyCard'), reply: $('#reply'), copy: $('#copy'), copied: $('#copied'), stats: $('#stats'), who: $('#who'), help: $('#help'),
};

function setState(kind, title, detail = '') {
  ui.dot.className = `dot ${kind}`;
  ui.state.textContent = title;
  ui.detail.textContent = detail;
}

// ---------------------------------------------------------------------------
async function listDevices() {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* ignore */ }
  const prevV = ui.vsel.value, prevA = ui.asel.value;
  const cams = devs.filter((d) => d.kind === 'videoinput' && d.deviceId);
  const mics = devs.filter((d) => d.kind === 'audioinput' && d.deviceId);
  ui.vsel.replaceChildren(
    ...(cams.length && cams[0].label ? cams.map((d) => el('option', { value: d.deviceId }, d.label)) : [el('option', { value: 'default' }, 'Default camera')]),
    navigator.mediaDevices.getDisplayMedia ? el('option', { value: 'screen' }, 'Share screen / window') : null,
    el('option', { value: 'none' }, 'No video (audio only)'));
  ui.asel.replaceChildren(
    ...(mics.length && mics[0].label ? mics.map((d) => el('option', { value: d.deviceId }, d.label)) : [el('option', { value: 'default' }, 'Default microphone')]),
    el('option', { value: 'none' }, 'No audio (video only)'));
  if ([...ui.vsel.options].some((o) => o.value === prevV)) ui.vsel.value = prevV;
  if ([...ui.asel.options].some((o) => o.value === prevA)) ui.asel.value = prevA;
}

function quality() {
  const [w, h, fps] = ui.qsel.value.split('x').map(Number);
  return { w, h, fps };
}

async function capture() {
  const { w, h, fps } = quality();
  const tracks = [];
  const v = ui.vsel.value, a = ui.asel.value;
  if (v === 'screen') {
    const ds = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } }, audio: false });
    const t = ds.getVideoTracks()[0];
    t.contentHint = 'detail';
    tracks.push(t);
  }
  const wantCam = v !== 'screen' && v !== 'none';
  const wantMic = a !== 'none';
  if (wantCam || wantMic) {
    const s = await navigator.mediaDevices.getUserMedia({
      video: wantCam ? { deviceId: v === 'default' ? undefined : { exact: v }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } } : false,
      audio: wantMic ? { deviceId: a === 'default' ? undefined : { exact: a }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    });
    for (const t of s.getTracks()) { if (t.kind === 'video') t.contentHint = 'motion'; tracks.push(t); }
  }
  if (!tracks.length) throw new Error('Choose at least a video or an audio source.');
  return new MediaStream(tracks);
}

async function startPreview() {
  const next = await capture();
  if (local) {
    // Live device switch without renegotiation where a sender already exists.
    for (const t of next.getTracks()) {
      const sender = pc?.getSenders().find((s) => s.track?.kind === t.kind);
      if (sender) await sender.replaceTrack(t);
    }
    for (const t of local.getTracks()) t.stop();
  }
  local = next;
  ui.self.srcObject = local;
  await listDevices();
  local.getVideoTracks()[0]?.addEventListener('ended', () => setState('failed', 'Video source ended', 'The camera or screen share stopped. Pick a source again.'));
}

// ---------------------------------------------------------------------------
async function answerOffer(msg) {
  closePc();
  offerMsg = msg;
  pc = new RTCPeerConnection(rtcConfig(msg.ice || {}));
  sampler = new StatsSampler(pc);
  pc.ondatachannel = (e) => {
    const dc = e.channel;
    ctl = dc;
    dc.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'tally') {
        ui.frame.classList.toggle('pgm', !!m.pgm);
        ui.frame.classList.toggle('pvw', !m.pgm && !!m.pvw);
        ui.tally.textContent = m.pgm ? 'ON AIR' : m.pvw ? 'PREVIEW' : '';
      } else if (m.type === 'hello' || m.type === 'name') {
        ui.who.textContent = `as “${m.name}”`;
      } else if (m.type === 'bye') {
        setState('ended', 'The studio disconnected you', 'The operator closed this source.');
        leave(false);
      }
    };
    dc.onopen = () => {
      const vt = local?.getVideoTracks()[0];
      const s = vt?.getSettings() || {};
      dc.send(JSON.stringify({ type: 'info', device: vt?.label || local?.getAudioTracks()[0]?.label || '', width: s.width, height: s.height, fps: s.frameRate }));
    };
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') { setState('live', 'Connected to the studio', 'Your video is reaching the studio. Keep this page open.'); ui.replyCard.classList.add('hidden'); keepAwake(); }
    else if (st === 'disconnected') setState('unstable', 'Connection unstable', 'Trying to recover…');
    else if (st === 'failed') {
      setState('failed', 'Connection failed', relay ? 'Reconnecting automatically…' : 'Ask the studio operator for a new invite link. If this keeps happening, the studio needs a TURN server for your network.');
      if (relay && joined) setTimeout(() => sayHello(), 2000);
    }
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
  for (const t of local.getTracks()) pc.addTrack(t, local);
  await pc.setLocalDescription(await pc.createAnswer());
  await tuneSenders();
  await waitForIceGathering(pc);
  return pc.localDescription.sdp;
}

async function tuneSenders() {
  const { fps } = quality();
  for (const s of pc.getSenders()) {
    if (!s.track) continue;
    try {
      const p = s.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      if (s.track.kind === 'video') {
        p.encodings[0].maxBitrate = Number(ui.bitrate.value) * 1000;
        p.encodings[0].maxFramerate = fps;
        p.degradationPreference = 'balanced';
      } else {
        p.encodings[0].maxBitrate = 128000;
      }
      await s.setParameters(p);
    } catch (e) { console.warn('setParameters', e); }
  }
}

function closePc() {
  if (pc) { try { pc.close(); } catch { /* ignore */ } }
  pc = null; sampler = null;
}

async function join() {
  ui.go.disabled = true;
  try {
    setState('connecting', 'Starting camera…');
    await startPreview();
    joined = true;
    ui.stop.classList.remove('hidden');
    ui.go.textContent = 'Apply device change';
    if (offerCode) {
      setState('connecting', 'Preparing reply code…', 'Gathering network addresses.');
      const msg = offerMsg || await decodeSignal(offerCode);
      if (msg.t !== 'offer' || msg.role !== 'contribute') throw new Error('This link is not a contributor invite.');
      const sdp = await answerOffer(msg);
      const code = await encodeSignal({ t: 'answer', slot: msg.slot, sdp });
      ui.reply.value = code;
      ui.replyCard.classList.remove('hidden');
      setState('invited', 'Send the reply code to the studio', 'Copy the code below and send it to the operator. You are connected as soon as they paste it.');
    } else if (relay) {
      sayHello();
    }
  } catch (e) {
    setState('failed', 'Could not start', e.name === 'NotAllowedError' ? 'Camera/microphone permission was denied. Allow it in the browser and try again.' : e.message);
    ui.go.textContent = 'Join studio';
    joined = false;
  } finally {
    ui.go.disabled = false;
  }
}

async function applyDevices() {
  try {
    const hadKinds = new Set(local.getTracks().map((t) => t.kind));
    await startPreview();
    const nowKinds = new Set(local.getTracks().map((t) => t.kind));
    await tuneSenders();
    if ([...nowKinds].some((k) => !hadKinds.has(k))) {
      setState('warn', 'Rejoin needed', 'You added audio or video that was not part of the connection. Leave and use a new invite (or wait for automatic reconnection) to include it.');
    }
  } catch (e) {
    setState('failed', 'Device change failed', e.message);
  }
}

function sayHello() {
  if (!relay || !joined) return;
  setState('connecting', 'Contacting the studio…', 'Waiting for the studio to answer. It reconnects automatically.');
  relay.send('studio', { type: 'hello' }).catch((e) => setState('failed', relayCfg?.meet ? 'Can\'t reach the studio yet' : 'Signaling relay unreachable', relayCfg?.meet ? `${e.message} Retrying by itself.` : e.message));
}

function sendBye() {
  try { if (ctl?.readyState === 'open') ctl.send(JSON.stringify({ type: 'bye' })); } catch { /* ignore */ }
  if (relay) relay.send('studio', { type: 'bye' }).catch(() => {});
}

function leave(notify = true) {
  if (notify) sendBye();
  joined = false;
  closePc();
  if (local) for (const t of local.getTracks()) t.stop();
  local = null;
  ui.self.srcObject = null;
  ui.go.textContent = 'Join studio';
  ui.stop.classList.add('hidden');
  ui.replyCard.classList.add('hidden');
  ui.frame.classList.remove('pgm', 'pvw');
  wakeLock?.release().catch(() => {});
  if (notify) setState('ended', 'You left the studio', offerCode ? 'To rejoin, ask the operator for a new invite link.' : 'Press Join to come back.');
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}

// ---------------------------------------------------------------------------
setInterval(async () => {
  if (!sampler) { ui.stats.replaceChildren(); return; }
  const st = await sampler.sample();
  if (!st) return;
  const v = st.out.video, a = st.out.audio, p = st.pair;
  ui.stats.replaceChildren(...[
    v && fmtRes(v.width, v.height), v?.fps !== undefined && `${Math.round(v.fps)} fps`, v && `video ${fmtKbps(v.kbps)}`, a && `audio ${fmtKbps(a.kbps)}`,
    v?.codec, v?.limitation && v.limitation !== 'none' && `limited by ${v.limitation}`, p?.rtt !== undefined && `rtt ${fmtMs(p.rtt)}`,
    p?.availOut && `available ${fmtKbps(p.availOut)}`,
  ].filter(Boolean).map((t) => el('span', {}, t)));
}, 1000);

ui.go.addEventListener('click', () => (joined ? applyDevices() : join()));
ui.stop.addEventListener('click', () => leave(true));
ui.copy.addEventListener('click', async () => { ui.copied.textContent = (await copyText(ui.reply.value)) ? 'Copied' : 'Select the text and copy it manually'; });
ui.frame.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : ui.frame.requestFullscreen?.()));
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
window.addEventListener('pagehide', () => { if (joined) sendBye(); });

(async function init() {
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    setState('failed', 'Unsupported browser', 'This browser cannot capture or send WebRTC media. Use a current Chrome, Edge, Firefox or Safari over HTTPS.');
    ui.go.disabled = true;
    return;
  }
  await listDevices();
  if (offerCode) {
    try {
      offerMsg = await decodeSignal(offerCode);
      ui.who.textContent = offerMsg.name ? `as “${offerMsg.name}”` : '';
      setState('idle', 'Ready', 'Choose your camera and microphone, then press Join studio.');
      ui.help.textContent = 'This link works once. Media goes directly from your browser to the studio; nothing is uploaded to a server.';
    } catch (e) {
      setState('failed', 'Invalid invite link', e.message);
      ui.go.disabled = true;
    }
  } else if (relayCfg) {
    ui.who.textContent = relayCfg.name ? `as “${relayCfg.name}”` : '';
    relay = relayCfg.meet
      ? new PublicRelay({ room: relayCfg.room, key: relayCfg.key, peer: `src-${relayCfg.slot}` })
      : new Relay(relayCfg.sig, relayCfg.room, `src-${relayCfg.slot}`);
    relay.on('state', (st) => { if (st === 'open' && joined && (!pc || pc.connectionState !== 'connected')) sayHello(); });
    relay.on('message', async (m) => {
      if (m.from !== 'studio') return;
      if (m.type === 'offer' && joined) {
        try {
          studioBoot = m.boot || null;
          const sdp = await answerOffer(m);
          await relay.send('studio', { type: 'answer', sdp, gen: m.gen });
          setState('connecting', 'Connecting to the studio…');
        } catch (e) { setState('failed', 'Negotiation failed', e.message); }
      } else if (m.type === 'rehello') {
        // The studio reloaded (new boot) or asked explicitly: our old connection is gone even if
        // the browser hasn't noticed yet, so redo the handshake now instead of waiting for it to time out.
        const studioRestarted = m.force || (m.boot && m.boot !== studioBoot);
        if (joined && (studioRestarted || !pc || pc.connectionState !== 'connected')) { await sleep(300); sayHello(); }
      } else if (m.type === 'bye') {
        closePc();
        setState('ended', 'The studio disconnected you', 'Press Join studio to offer your feed again.');
        joined = false; ui.go.textContent = 'Join studio';
      } else if (m.type === 'unknown-slot') {
        setState('failed', 'Unknown source', 'The studio no longer has this source. Ask the operator for a new link.');
      }
    });
    relay.connect();
    setState('idle', 'Ready', 'Choose your camera and microphone, then press Join studio.');
    ui.help.textContent = relayCfg.meet
      ? 'This link is reusable: keep this page open and it reconnects by itself, even if the studio reloads. Video goes directly from your browser to the studio; only a short encrypted handshake passes through public meeting points.'
      : 'This link is reusable and reconnects automatically. Media goes directly from your browser to the studio; the signaling relay only passes connection details.';
  } else {
    setState('failed', 'No invite', 'Open the invite link the studio operator sent you.');
    ui.go.disabled = true;
  }
})();
