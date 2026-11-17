// Connection to the mailbox (mailbox/worker.js), from the studio or a guest.
// A web page can't receive the HTTP request a WHIP encoder sends, or find
// another browser by itself, so each WHIP or reusable-link source keeps a
// WebSocket open to its own box on the mailbox. The mailbox passes connection
// details (SDP) through it; the video then flows directly between the pages.
import { Emitter } from './util.js';

// The mailbox this site uses. Settings → Network can override it.
export const MAILBOX_URL = '';

export function mailboxBase(settings) {
  return String(settings?.mailboxUrl || MAILBOX_URL || '').trim().replace(/\/+$/, '');
}

export class MailboxSocket extends Emitter {
  /** The studio passes its key for the box; a guest page passes none. */
  constructor(base, box, key = null) {
    super();
    const ws = base.replace(/^http/i, 'ws');
    this.url = key ? `${ws}/studio/${encodeURIComponent(box)}?key=${encodeURIComponent(key)}` : `${ws}/guest/${encodeURIComponent(box)}`;
    this.state = 'connecting'; // connecting | open | closed | replaced
    this.tries = 0;
    this.closed = false;
    this._open();
  }

  _setState(st) {
    if (this.state === st) return;
    this.state = st;
    this.emit('state', st);
  }

  _open() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch { return this._retry(); }
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this._setState('open');
      clearInterval(this.ping);
      // Keeps proxies and NAT routers from dropping an idle connection.
      this.ping = setInterval(() => { try { ws.send('{"type":"ping"}'); } catch { /* reconnects on close */ } }, 25000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type && m.type !== 'pong') this.emit('message', m);
    };
    ws.onclose = (e) => {
      clearInterval(this.ping);
      if (this.ws !== ws || this.closed) return;
      // 4000: the same source was opened in another studio tab, which now owns
      // the box. 4001: the guest link was opened in another tab or device.
      if (e.code === 4000 || e.code === 4001) { this._setState('replaced'); return; }
      this._retry();
    };
  }

  _retry() {
    if (this.closed) return;
    this._setState('closed');
    const delay = Math.min(30, 2 ** Math.min(this.tries++, 5)) * 1000;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this._setState('connecting'); this._open(); }, delay);
  }

  /** Reconnect now (also takes the box back from another tab). */
  reopen() {
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.tries = 0;
    this._setState('connecting');
    this._open();
  }

  send(msg) {
    if (this.ws?.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer); clearInterval(this.ping);
    try { this.ws?.close(1000); } catch { /* ignore */ }
  }
}
