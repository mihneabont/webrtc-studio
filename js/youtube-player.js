// YouTube player window for a "YouTube" source. It plays the video with
// YouTube's own embedded player (IFrame Player API); nothing is downloaded.
// After one click on Start, it shares this window (tab capture of itself) and
// hands the live stream to the studio window that opened it. The studio then
// controls playback through postMessage (play, pause, seek, loop).
const params = new URLSearchParams(location.hash.slice(1));
const sid = params.get('sid');
const videoId = params.get('v');
let start = Number(params.get('t')) || 0;
let loop = params.get('loop') === '1';
const studio = window.opener;
const $ = (id) => document.getElementById(id);
const ui = { start: $('start'), title: $('title'), go: $('go'), hint: $('hint') };

let player = null;
let stream = null;
let lastSent = '';

function post(msg) {
  try { studio?.postMessage({ type: 'yt-status', sid, ...msg }, location.origin); } catch { /* studio closed */ }
}

function status(extra = {}) {
  if (!player?.getPlayerState) return;
  const msg = {
    state: ({ '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' })[player.getPlayerState()] || 'unknown',
    time: player.getCurrentTime?.() || 0, duration: player.getDuration?.() || 0,
    title: player.getVideoData?.()?.title || '', loop, captured: !!stream, ...extra,
  };
  const sig = JSON.stringify({ ...msg, time: Math.floor(msg.time) });
  if (sig !== lastSent || extra.force) { lastSent = sig; post(msg); }
}

function fail(text) {
  ui.start.hidden = false;
  ui.go.hidden = true;
  ui.title.textContent = 'This video can\'t be played here';
  ui.hint.textContent = text;
  ui.hint.className = 'err';
  post({ error: text });
}

const ERRORS = {
  2: 'The link doesn\'t point to a valid YouTube video.',
  5: 'YouTube\'s player could not play this video in this browser.',
  100: 'The video was not found. It may be private or removed.',
  101: 'The video\'s owner doesn\'t allow it to be played on other sites.',
  150: 'The video\'s owner doesn\'t allow it to be played on other sites.',
};

// Share this very window with the studio (one click, then "Allow").
async function capture() {
  ui.go.disabled = true;
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      // Tab audio, not played out of this window as well (the studio's monitor plays it).
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude',
    });
    stream = s;
    for (const t of s.getTracks()) t.addEventListener('ended', () => { stream = null; post({ captured: false, stopped: true }); ui.start.hidden = false; ui.go.disabled = false; ui.title.textContent = 'Sharing stopped'; });
    ui.start.hidden = true;
    if (!studio || studio.closed || typeof studio.__studioYouTubeStream !== 'function') throw new Error('The studio window is gone. Close this window and press Connect in the studio again.');
    studio.__studioYouTubeStream(sid, s);
    status({ force: true });
  } catch (e) {
    ui.go.disabled = false;
    ui.start.hidden = false;
    ui.hint.className = 'err';
    ui.hint.textContent = e.name === 'NotAllowedError' ? 'Sharing was not allowed. Click Start again and choose Allow to send this window to the studio.' : e.message;
  }
}

ui.go.addEventListener('click', async () => {
  player?.playVideo?.(); // this click also lets the video play with sound
  await capture();
});

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== studio) return;
  const m = e.data;
  if (!m || m.type !== 'yt-cmd' || m.sid !== sid || !player) return;
  if (m.cmd === 'play') player.playVideo();
  else if (m.cmd === 'pause') player.pauseVideo();
  else if (m.cmd === 'restart') { player.seekTo(0, true); player.playVideo(); }
  else if (m.cmd === 'seek') player.seekTo(Number(m.arg) || 0, true);
  else if (m.cmd === 'loop') loop = !!m.arg;
  else if (m.cmd === 'load' && m.arg?.id) { start = m.arg.start || 0; player.cueVideoById({ videoId: m.arg.id, startSeconds: start }); }
  else if (m.cmd === 'ping') { /* answered below */ }
  status({ force: true });
});

// The studio closing ends this window's job.
setInterval(() => { if (!studio || studio.closed) { stream?.getTracks().forEach((t) => t.stop()); window.close(); } }, 2000);
setInterval(() => status(), 500);

if (!videoId || !sid) {
  fail('Open this window from a YouTube source in the studio.');
} else {
  document.title = `YouTube · ${params.get('name') || 'source'} · WebRTC Studio`;
  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('player', {
      videoId,
      host: 'https://www.youtube.com',
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, playsinline: 1, rel: 0, start: Math.floor(start) },
      events: {
        onReady: () => {
          ui.title.textContent = player.getVideoData?.()?.title || 'Ready';
          ui.go.hidden = false;
          ui.hint.textContent = 'Click Start, then choose Allow to share this window with the studio. Keep the window open (it can be behind others) while you use the source.';
          status({ force: true });
        },
        onStateChange: (e) => {
          if (e.data === 0 && loop) { player.seekTo(0, true); player.playVideo(); }
          status({ force: true });
        },
        onError: (e) => fail(ERRORS[e.data] || `YouTube reported error ${e.data}.`),
      },
    });
  };
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = () => fail('YouTube\'s player could not be loaded. Check the internet connection.');
  document.head.append(s);
}
