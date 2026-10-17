// YouTube sources. The video plays in YouTube's own embedded player (IFrame
// Player API) inside this page, hidden behind the studio. A page can't read
// another site's video, so the studio captures this tab restricted to that one
// player element (Element Capture): the source is exactly the video, with no
// browser bar or studio around it, and nothing is downloaded. All YouTube
// sources share one capture, so the browser asks to share "this tab" once.

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
 * The hidden players. They are tiled in one stage behind an opaque cover, so
 * the operator never sees them. Chrome allows only one capture of a tab at a
 * time, so the stage is captured once (Element Capture, one "share this tab"
 * prompt for all YouTube sources) and each player is cut out of that capture
 * into its own video stream. The tab's sound is shared too: a player is only
 * unmuted while its source is on air (setOnAir), so the programme carries the
 * on-air video's sound and never the cued ones.
 */
export class YouTubeStage {
  constructor(onStatus, onEnded) {
    this.onStatus = onStatus; // (id, status) -> void
    this.onEnded = onEnded; // (id) -> void: sharing was stopped
    this.players = new Map(); // id -> { player, box, canvas, out, loop, last, manualMute, onAir }
    this.root = null;
    this.shared = null; // { stream, video, audio }
    this.onAir = new Set();
    setInterval(() => { for (const id of this.players.keys()) this._report(id); }, 500);
    this.timer = null;
  }

  _mount() {
    if (this.root) return;
    this.root = document.createElement('div');
    this.root.className = 'yt-stage';
    this.root.setAttribute('aria-hidden', 'true');
    const cover = document.createElement('div');
    cover.className = 'yt-cover';
    document.body.append(this.root, cover);
    window.addEventListener('resize', () => this._layout());
  }

  // Tile the players so that together they fill as much of the window as possible
  // (a capture can't be bigger than the window); bigger tiles give sharper video.
  _layout() {
    const boxes = [...this.players.values()].map((e) => e.box);
    if (!this.root || !boxes.length) return;
    const n = boxes.length;
    const W = window.innerWidth, H = window.innerHeight;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.floor(Math.min(W / cols, (H / rows) * 16 / 9));
      if (!best || w > best.w) best = { cols, rows, w };
    }
    const w = best.w, h = Math.floor(w * 9 / 16);
    boxes.forEach((b, i) => {
      Object.assign(b.style, { width: `${w}px`, height: `${h}px`, left: `${(i % best.cols) * w}px`, top: `${Math.floor(i / best.cols) * h}px` });
      const f = b.querySelector('iframe');
      if (f) { f.width = w; f.height = h; }
    });
    this.root.style.width = `${best.cols * w}px`;
    this.root.style.height = `${best.rows * h}px`;
  }

  // One capture of the stage for all players. Must start from a click.
  _share() {
    if (this.shared) return Promise.resolve(this.shared);
    this.sharing ||= navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      // The videos' sound goes to the programme only: not played out of this computer.
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude', monitorTypeSurfaces: 'exclude',
    }).then(async (stream) => {
      const track = stream.getVideoTracks()[0];
      // Only the stage, nothing else of the page (and not what covers it).
      await track.restrictTo(await window.RestrictionTarget.fromElement(this.root));
      // Full size: by default Chrome scales a capture down to about 800 pixels wide.
      await track.applyConstraints({ resizeMode: 'none', frameRate: 30 }).catch(() => {});
      const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: stream });
      video.play().catch(() => {}); // frames arrive by themselves; drawing waits for them
      this.shared = { stream, video, audio: stream.getAudioTracks()[0] || null };
      track.addEventListener('ended', () => this._unshare(true));
      this.timer = setInterval(() => this._draw(), 1000 / 30);
      return this.shared;
    }).finally(() => { this.sharing = null; });
    return this.sharing;
  }

  _unshare(stoppedByUser = false) {
    clearInterval(this.timer);
    this.timer = null;
    const sh = this.shared;
    this.shared = null;
    sh?.stream.getTracks().forEach((t) => t.stop());
    if (sh) sh.video.srcObject = null;
    if (stoppedByUser) for (const id of [...this.players.keys()]) { this.close(id); this.onEnded(id); }
  }

  // Cut each player out of the shared capture.
  _draw() {
    const sh = this.shared;
    const vw = sh?.video.videoWidth, vh = sh?.video.videoHeight;
    if (!vw || !vh || !this.root.offsetWidth) return;
    const sx = vw / this.root.offsetWidth, sy = vh / this.root.offsetHeight;
    for (const e of this.players.values()) {
      if (!e.canvas) continue;
      const w = Math.round(e.box.offsetWidth * sx), h = Math.round(e.box.offsetHeight * sy);
      if (!w || !h) continue;
      if (e.canvas.width !== w || e.canvas.height !== h) { e.canvas.width = w; e.canvas.height = h; }
      e.g.drawImage(sh.video, Math.round(e.box.offsetLeft * sx), Math.round(e.box.offsetTop * sy), w, h, 0, 0, w, h);
    }
  }

  /**
   * Load a video and give it its own stream. Call from a click (the first one
   * asks to share this tab). Resolves to a MediaStream: the video's picture,
   * plus the shared YouTube sound.
   */
  async open(id, { videoId, start = 0, loop = false }) {
    this.close(id);
    this._mount();
    const box = document.createElement('div');
    box.className = 'yt-box';
    const holder = document.createElement('div');
    box.append(holder);
    this.root.append(box);
    const entry = { player: null, box, canvas: null, g: null, out: null, loop, last: '', manualMute: false };
    this.players.set(id, entry);
    this._layout();
    try {
      // Ask to share first, while the click still counts; the player loads meanwhile.
      await Promise.all([this._share(), this._player(id, entry, holder, videoId, start)]);
    } catch (e) {
      this.close(id);
      throw e.name === 'NotAllowedError' ? new Error('Sharing was not allowed. Click Connect again and choose Allow (the studio captures only the YouTube videos).') : e;
    }
    entry.canvas = document.createElement('canvas');
    entry.g = entry.canvas.getContext('2d', { alpha: false });
    this._draw();
    const tracks = [entry.canvas.captureStream(30).getVideoTracks()[0]];
    if (this.shared.audio) tracks.push(this.shared.audio.clone());
    entry.out = new MediaStream(tracks);
    this._applyMute(id);
    return entry.out;
  }

  _player(id, entry, holder, videoId, start) {
    return loadApi().then(() => new Promise((resolve, reject) => {
      entry.player = new window.YT.Player(holder, {
        videoId, width: entry.box.offsetWidth, height: entry.box.offsetHeight, host: 'https://www.youtube.com',
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, playsinline: 1, rel: 0, start: Math.floor(start) },
        events: {
          onReady: () => { this._applyMute(id); this._report(id, true); resolve(); },
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

  /**
   * Which sources are on air (in Programme, or in a transition). Their players
   * are unmuted; all others are muted. When several are on air at once, only
   * the first one's audio track carries the (shared) sound, so it isn't doubled.
   */
  setOnAir(ids, order = []) {
    this.onAir = new Set(ids);
    const carrier = order.find((id) => this.onAir.has(id) && this.players.has(id));
    for (const [id, e] of this.players) {
      this._applyMute(id);
      for (const t of e.out?.getAudioTracks() || []) t.enabled = id === carrier || !this.onAir.has(id);
    }
  }

  _applyMute(id) {
    const e = this.players.get(id);
    const p = e?.player;
    if (!p?.mute) return;
    if (e.manualMute || !this.onAir.has(id)) p.mute(); else p.unMute();
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
    else if (cmd === 'mute') { e.manualMute = !!arg; this._applyMute(id); }
    this._report(id, true);
  }

  close(id) {
    const e = this.players.get(id);
    if (!e) return;
    this.players.delete(id);
    e.out?.getTracks().forEach((t) => t.stop());
    try { e.player?.destroy?.(); } catch { /* already gone */ }
    e.box.remove();
    this._layout();
    // The last one gone: stop sharing (removes the browser's sharing bar).
    if (!this.players.size && this.shared) this._unshare();
  }

  _report(id, force = false) {
    const e = this.players.get(id);
    const p = e?.player;
    if (!p?.getPlayerState) return;
    const st = {
      state: STATES[p.getPlayerState()] || 'unknown',
      time: p.getCurrentTime?.() || 0, duration: p.getDuration?.() || 0,
      title: p.getVideoData?.()?.title || '', loop: e.loop,
      muted: e.manualMute, onAir: this.onAir.has(id),
    };
    const sig = JSON.stringify({ ...st, time: Math.floor(st.time) });
    if (!force && sig === e.last) return;
    e.last = sig;
    this.onStatus(id, st);
  }
}
