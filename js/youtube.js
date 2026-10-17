// YouTube sources: links. Each video plays in YouTube's own player in its own
// small window (youtube.html, js/youtube-player.js), which captures only its
// player and hands the stream to the studio; nothing is downloaded.

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

/** Can this browser capture a single element of a page (Chrome / Edge 132+)? */
export const youTubeSupported = () => typeof window.RestrictionTarget === 'function' && !!navigator.mediaDevices?.getDisplayMedia;
