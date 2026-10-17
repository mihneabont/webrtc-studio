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

/** Can this browser capture a single element of the page (Chrome / Edge 132+)? */
export const youTubeSupported = () => typeof window.RestrictionTarget === 'function' && !!navigator.mediaDevices?.getDisplayMedia;

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
  async open(id, { videoId, start = 0, loop = false, width = 1280, height = 720, maxWidth = 1920, maxHeight = 1080 }) {
    this.close(id);
    this._mount();
    // Ask to share first, while the click still counts; the player loads meanwhile.
    const capture = navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { max: maxWidth }, height: { max: maxHeight } },
      // The video's sound goes to the programme only: not played out of this computer.
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude', monitorTypeSurfaces: 'exclude',
    });
    const box = document.createElement('div');
    box.className = 'yt-box';
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    const holder = document.createElement('div');
    box.append(holder);
    this.root.append(box);
    const entry = { player: null, box, stream: null, loop, last: '' };
    this.players.set(id, entry);
    let stream;
    try {
      [stream] = await Promise.all([capture, this._player(id, entry, holder, videoId, start, width, height)]);
    } catch (e) {
      capture.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      this.close(id);
      throw e.name === 'NotAllowedError' ? new Error('Sharing was not allowed. Click Connect again and choose Allow (the studio captures only the video).') : e;
    }
    const video = stream.getVideoTracks()[0];
    // Only the player's box, nothing else of the page (and not what covers it).
    await video.restrictTo(await window.RestrictionTarget.fromElement(box));
    entry.stream = stream;
    return stream;
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
    e.stream?.getTracks().forEach((t) => t.stop());
    try { e.player?.destroy?.(); } catch { /* already gone */ }
    e.box.remove();
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
