// YouTube sources. The video plays in YouTube's own embedded player (IFrame
// Player API) inside this page, hidden behind the studio. A page can't read
// another site's video, so the studio captures this tab restricted to that one
// player element (Element Capture): the source is exactly the video, with no
// browser bar or studio around it, and nothing is downloaded. Each source asks
// once to share "this tab" when it connects (browsers require it).

const ID = /^[A-Za-z0-9_-]{11}$/;

// "90", "90s", "1m30s", "1h2m3s" -> seconds
function seconds(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) : 0;
}

/**
 * The video in a YouTube link: { id, start } or null. Accepts watch links,
 * youtu.be short links, /shorts/, /live/ and /embed/ links, with or without
 * https://, and a start time from t= or start=.
 */
export function parseYouTube(text) {
  let raw = String(text || '').trim();
  if (!raw) return null;
  if (ID.test(raw)) return { id: raw, start: 0 };
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
  }
  if (!id || !ID.test(id)) return null;
  return { id, start: seconds(u.searchParams.get('t') || u.searchParams.get('start')) };
}

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Can this browser capture a single element of the page (Chrome / Edge 132+)? Then the player stays hidden and its sound is captured. */
export const elementCapture = () => typeof window.RestrictionTarget === 'function' && !!navigator.mediaDevices?.getDisplayMedia;
/** Any capture at all. Without element capture (Firefox), the player must be visible, it shares a window, and there is no sound. */
export const youTubeSupported = () => !!navigator.mediaDevices?.getDisplayMedia;

const ERRORS = {
  2: 'The link doesn\'t point to a valid YouTube video.',
  5: 'YouTube\'s player could not play this video in this browser.',
  100: 'The video was not found. It may be private or removed.',
  101: 'The video\'s owner doesn\'t allow it to be played on other sites.',
  150: 'The video\'s owner doesn\'t allow it to be played on other sites.',
};
const STATES = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };

let apiReady = null;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve();
  apiReady ||= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiReady = null; reject(new Error('YouTube\'s player could not be loaded. Check the internet connection.')); };
    document.head.append(s);
  });
  return apiReady;
}

/**
 * The hidden players. Each player sits in its own box behind an opaque cover,
 * so the operator never sees it, but Element Capture still gets its pixels.
 */
export class YouTubeStage {
  constructor(onStatus) {
    this.onStatus = onStatus; // (id, status) -> void
    this.players = new Map(); // id -> { player, box, track, loop, last }
    this.root = null;
    setInterval(() => { for (const id of this.players.keys()) this._report(id); }, 500);
  }

  _mount() {
    if (this.root) return;
    this.root = document.createElement('div');
    this.root.className = 'yt-stage';
    this.root.setAttribute('aria-hidden', 'true');
    const cover = document.createElement('div');
    cover.className = 'yt-cover';
    document.body.append(this.root, cover);
  }

  /**
   * Load a video and capture its player. Call from a click (the share prompt
   * needs one). Resolves to a MediaStream with the player's picture and the
   * tab's sound.
   */
  async open(id, { videoId, start = 0, loop = false, width = 1280, height = 720, maxWidth = 1920, maxHeight = 1080, label = '' }) {
    this.close(id);
    const hidden = elementCapture();
    if (hidden) this._mount();
    // Ask to share first, while the click still counts; the player loads meanwhile.
    const capture = hidden
      ? navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 }, width: { max: maxWidth }, height: { max: maxHeight } },
        // The video's sound goes to the programme only: not played out of this computer.
        audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude', monitorTypeSurfaces: 'exclude',
      })
      : navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
    const box = document.createElement('div');
    box.className = 'yt-box';
    const holder = document.createElement('div');
    box.append(holder);
    let frame = null;
    if (hidden) {
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      this.root.append(box);
    } else {
      // Firefox: the player has to be on screen to be captured. It sits in a
      // small frame in a corner; the studio crops it out of the shared window.
      width = 480; height = 270;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      frame = document.createElement('div');
      frame.className = 'yt-visible';
      const grip = Object.assign(document.createElement('div'), { className: 'yt-visible-label', title: 'Drag to move', textContent: `YouTube${label ? ` · ${label}` : ''}: keep visible, this is what the studio shares (drag here to move)` });
      frame.append(grip, box);
      document.body.append(frame);
      // Drag it out of the way: the crop follows wherever it is.
      grip.addEventListener('pointerdown', (e) => {
        const r = frame.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
        grip.setPointerCapture(e.pointerId);
        const move = (ev) => {
          frame.style.left = `${Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx))}px`;
          frame.style.top = `${Math.max(0, Math.min(window.innerHeight - r.height, ev.clientY - dy))}px`;
          frame.style.right = frame.style.bottom = 'auto';
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', () => grip.removeEventListener('pointermove', move), { once: true });
      });
    }
    const entry = { player: null, box, frame, stream: null, loop, last: '', hidden, stop: null };
    this.players.set(id, entry);
    let stream;
    try {
      [stream] = await Promise.all([capture, this._player(id, entry, holder, videoId, start, width, height)]);
    } catch (e) {
      capture.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      this.close(id);
      throw e.name === 'NotAllowedError' ? new Error(`Sharing was not allowed. Click Connect again and choose ${hidden ? 'Allow' : 'this Firefox window, then Allow'}.`) : e;
    }
    if (hidden) {
      // Only the player's box, nothing else of the page (and not what covers it).
      await stream.getVideoTracks()[0].restrictTo(await window.RestrictionTarget.fromElement(box));
      entry.stream = stream;
      return stream;
    }
    // Firefox: its sound can't reach the programme, so don't play it here either.
    entry.player.mute();
    entry.stream = this._crop(entry, stream);
    return entry.stream;
  }

  // Cut the player out of a shared window or screen (Firefox), into a canvas stream.
  _crop(entry, shared) {
    const track = shared.getVideoTracks()[0];
    const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: shared });
    video.play().catch(() => {});
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { alpha: false });
    const draw = () => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      const r = entry.box.getBoundingClientRect();
      const surface = track.getSettings().displaySurface;
      let scale, ox, oy;
      if (surface === 'monitor') { // a whole screen: the page's position on it
        scale = vw / window.screen.width;
        ox = (window.mozInnerScreenX ?? window.screenX) - (window.screen.left || 0);
        oy = (window.mozInnerScreenY ?? window.screenY) - (window.screen.top || 0);
      } else if (surface === 'browser') { // just the page
        scale = vw / window.innerWidth; ox = 0; oy = 0;
      } else { // a window: the page's position inside it, below the toolbars
        scale = vw / window.outerWidth;
        ox = (window.mozInnerScreenX ?? window.screenX) - window.screenX;
        oy = (window.mozInnerScreenY ?? (window.screenY + window.outerHeight - window.innerHeight)) - window.screenY;
      }
      const sw = Math.round(r.width * scale), sh = Math.round(r.height * scale);
      if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
      g.drawImage(video, Math.round((ox + r.left) * scale), Math.round((oy + r.top) * scale), sw, sh, 0, 0, canvas.width, canvas.height);
    };
    const timer = setInterval(draw, 1000 / 30);
    const out = canvas.captureStream(30);
    const outTrack = out.getVideoTracks()[0];
    entry.stop = () => { clearInterval(timer); track.stop(); video.srcObject = null; };
    // Stopping the share in Firefox's bar ends the source too.
    track.addEventListener('ended', () => { entry.stop?.(); outTrack.stop(); outTrack.dispatchEvent(new Event('ended')); });
    return out;
  }

  _player(id, entry, holder, videoId, start, width, height) {
    return loadApi().then(() => new Promise((resolve, reject) => {
      entry.player = new window.YT.Player(holder, {
        videoId, width, height, host: 'https://www.youtube.com',
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, playsinline: 1, rel: 0, start: Math.floor(start) },
        events: {
          onReady: () => { this._report(id, true); resolve(); },
          onStateChange: (e) => {
            if (e.data === 0 && entry.loop) { entry.player.seekTo(0, true); entry.player.playVideo(); }
            this._report(id, true);
          },
          onError: (e) => {
            const msg = ERRORS[e.data] || `YouTube reported error ${e.data}.`;
            this.onStatus(id, { error: msg });
            reject(new Error(msg));
          },
        },
      });
    }));
  }

  command(id, cmd, arg) {
    const e = this.players.get(id);
    const p = e?.player;
    if (!p?.playVideo) return;
    if (cmd === 'play') p.playVideo();
    else if (cmd === 'pause') p.pauseVideo();
    else if (cmd === 'restart') { p.seekTo(0, true); p.playVideo(); }
    else if (cmd === 'seek') p.seekTo(Number(arg) || 0, true);
    else if (cmd === 'loop') e.loop = !!arg;
    else if (cmd === 'mute') (arg ? p.mute() : p.unMute());
    this._report(id, true);
  }

  close(id) {
    const e = this.players.get(id);
    if (!e) return;
    this.players.delete(id);
    e.stop?.();
    e.stream?.getTracks().forEach((t) => t.stop());
    try { e.player?.destroy?.(); } catch { /* already gone */ }
    e.box.remove();
    e.frame?.remove();
  }

  _report(id, force = false) {
    const e = this.players.get(id);
    const p = e?.player;
    if (!p?.getPlayerState) return;
    const st = {
      state: STATES[p.getPlayerState()] || 'unknown',
      time: p.getCurrentTime?.() || 0, duration: p.getDuration?.() || 0,
      title: p.getVideoData?.()?.title || '', loop: e.loop, muted: !!p.isMuted?.(),
    };
    const sig = JSON.stringify({ ...st, time: Math.floor(st.time) });
    if (!force && sig === e.last) return;
    e.last = sig;
    this.onStatus(id, st);
  }
}
