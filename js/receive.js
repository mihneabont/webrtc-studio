// Programme receiver: plays the studio's outgoing WebRTC programme.
import { $, el, copyText, fmtKbps, fmtRes, fmtMs } from './util.js';
import { decodeSignal, encodeSignal } from './codec.js';
import { rtcConfig, waitForIceGathering, StatsSampler } from './rtc.js';

const params = new URLSearchParams(location.hash.slice(1));
const offerCode = params.get('c');

const ui = {
  dot: $('#dot'), state: $('#state'), detail: $('#detail'), video: $('#pgm'), frame: $('#frame'), unmute: $('#unmute'),
  replyCard: $('#replyCard'), reply: $('#reply'), copy: $('#copy'), copied: $('#copied'), stats: $('#stats'), kv: $('#kv'),
  fs: $('#fs'), mute: $('#mute'), who: $('#who'),
};
let pc = null, sampler = null;
window.receiver = { get pc() { return pc; }, video: ui.video }; // for tests and debugging

function setState(kind, title, detail = '') {
  ui.dot.className = `dot ${kind}`;
  ui.state.textContent = title;
  ui.detail.textContent = detail;
}

async function answer(msg) {
  if (pc) pc.close();
  pc = new RTCPeerConnection(rtcConfig(msg.ice || {}));
  sampler = new StatsSampler(pc);
  const stream = new MediaStream();
  pc.ontrack = (e) => {
    stream.addTrack(e.track);
    ui.video.srcObject = stream;
    ui.video.play().catch(() => {});
    if (ui.video.muted) ui.unmute.classList.remove('hidden');
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') { setState('live', 'Receiving programme', 'Live from the studio.'); ui.replyCard.classList.add('hidden'); }
    else if (st === 'disconnected') setState('unstable', 'Connection unstable', 'Trying to recover…');
    else if (st === 'failed') setState('failed', 'Connection failed', 'Ask the operator to restart this output and send a new link.');
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIceGathering(pc);
  return pc.localDescription.sdp;
}

ui.unmute.addEventListener('click', () => { ui.video.muted = false; ui.video.play(); ui.unmute.classList.add('hidden'); ui.mute.textContent = 'Mute'; });
ui.mute.addEventListener('click', () => { ui.video.muted = !ui.video.muted; ui.mute.textContent = ui.video.muted ? 'Unmute' : 'Mute'; ui.unmute.classList.add('hidden'); });
ui.fs.addEventListener('click', () => ui.frame.requestFullscreen?.());
ui.frame.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : ui.frame.requestFullscreen?.()));
ui.copy.addEventListener('click', async () => { ui.copied.textContent = (await copyText(ui.reply.value)) ? 'Copied' : 'Select the text and copy it manually'; });
ui.mute.textContent = 'Unmute';

setInterval(async () => {
  if (!sampler) return;
  const st = await sampler.sample();
  if (!st) return;
  const v = st.in.video, a = st.in.audio, p = st.pair;
  ui.stats.replaceChildren(...[v && fmtRes(v.width, v.height), v?.fps !== undefined && `${Math.round(v.fps)} fps`,
    v && fmtKbps((v.kbps || 0) + (a?.kbps || 0)), v?.codec, p?.rtt !== undefined && `rtt ${fmtMs(p.rtt)}`].filter(Boolean).map((t) => el('span', {}, t)));
  const rows = [
    ['Video', v ? `${fmtRes(v.width, v.height)} · ${v.fps !== undefined ? Math.round(v.fps) : '–'} fps · ${fmtKbps(v.kbps)} · ${v.codec || ''}` : 'none'],
    ['Audio', a ? `${fmtKbps(a.kbps)} · ${a.codec || ''}` : 'none'],
    ['Loss', v ? `${((v.loss || 0) * 100).toFixed(2)}%` : '–'],
    ['Jitter', v?.jitter !== undefined ? fmtMs(v.jitter) : '–'],
    ['Frames dropped', v?.dropped ?? '–'], ['Freezes', v?.freezes ?? '–'],
    ['Round trip', p?.rtt !== undefined ? fmtMs(p.rtt) : '–'], ['Path', p ? `${p.local} → ${p.remote}` : '–'],
    ['Health', st.health],
  ];
  ui.kv.replaceChildren(...rows.flatMap(([k, val]) => [el('dt', {}, k), el('dd', {}, String(val))]));
}, 1000);

(async function init() {
  if (offerCode) {
    try {
      const msg = await decodeSignal(offerCode);
      if (msg.t !== 'offer' || msg.role !== 'receive') throw new Error('This link is not a programme receiver link.');
      ui.who.textContent = msg.name ? `“${msg.name}”` : '';
      setState('connecting', 'Preparing reply code…', 'Gathering network addresses.');
      const sdp = await answer(msg);
      ui.reply.value = await encodeSignal({ t: 'answer', out: msg.out, sdp });
      ui.replyCard.classList.remove('hidden');
      setState('invited', 'Send the reply code to the studio', 'You will see the programme as soon as the operator pastes it.');
    } catch (e) {
      setState('failed', 'Could not use this link', e.message);
    }
  } else {
    setState('failed', 'No link', 'Open the receiver link from the studio.');
  }
})();
