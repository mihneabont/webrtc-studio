// OPTIONAL signaling relay client (see signaling-server/). It only carries
// small JSON messages (SDP offers/answers) between pages; media never touches
// it. Without it, the app falls back to copy-paste codes.
import { Emitter } from './util.js';

export class Relay extends Emitter {
  constructor(baseUrl, room, peerId) {
    super();
    this.base = baseUrl.replace(/\/+$/, '');
    this.room = room;
    this.peer = peerId;
    this.state = 'idle';
    this.es = null;
  }

  connect() {
    this.close();
    this._set('connecting');
    const url = `${this.base}/r/${encodeURIComponent(this.room)}/${encodeURIComponent(this.peer)}`;
    try {
      this.es = new EventSource(url);
    } catch (e) {
      this._set('error', e.message);
      return;
    }
    this.es.onopen = () => this._set('open');
    this.es.onerror = () => this._set(this.es?.readyState === EventSource.CLOSED ? 'error' : 'connecting');
    this.es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.from) this.emit('message', msg);
    };
  }

  async send(to, msg) {
    const url = `${this.base}/r/${encodeURIComponent(this.room)}/${encodeURIComponent(to)}`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...msg, from: this.peer }),
    });
    if (!res.ok) throw new Error(`Signaling relay returned ${res.status}`);
  }

  close() {
    if (this.es) { this.es.close(); this.es = null; }
    this._set('closed');
  }

  _set(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state, detail);
  }
}
