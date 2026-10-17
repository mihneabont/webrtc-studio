// Reconnecting invite links without a server of our own. The studio and a
// contributor exchange their small connection messages (offer, answer, hello)
// through public MQTT brokers, used only as a mailbox. Media never goes there:
// it still flows directly between the two browsers.
//
// - Several independent brokers are used at once; a message goes to all of
//   them and duplicates are dropped, so one broker being down doesn't matter.
// - Every message is encrypted (AES-GCM) with the key from the invite link, and
//   the topic is derived from room + key, so brokers (and anyone else on them)
//   can neither read nor forge messages.
// - Same interface as Relay (relay.js): connect(), send(to, msg), close(),
//   'state' and 'message' events, so the studio and contributor pages use
//   either one the same way.
import { Emitter } from './util.js';

export const MEET_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];
const KEEPALIVE_S = 30;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** A new random link key (256 bits, base64url). */
export function newMeetKey() { return b64url(crypto.getRandomValues(new Uint8Array(32))); }

// --- MQTT 3.1.1, the few packets we need -------------------------------------
const mqttStr = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
function mqttPacket(first, body) {
  const len = []; let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; len.push(d); } while (n);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = first; out.set(len, 1); out.set(body, 1 + len.length);
  return out;
}

class Broker {
  constructor(url, topic, onPublish, onChange) {
    this.url = url; this.topic = topic; this.onPublish = onPublish; this.onChange = onChange;
    this.ws = null; this.ready = false; this.closed = false; this.backoff = 1000; this.buf = new Uint8Array(0);
    this.ping = null; this.retry = null;
  }

  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url, ['mqtt']); } catch { this._retry(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      const id = `wrtc-${Math.random().toString(36).slice(2, 12)}`;
      ws.send(mqttPacket(0x10, [...mqttStr('MQTT'), 4, 0x02, 0, KEEPALIVE_S, ...mqttStr(id)]));
    };
    ws.onmessage = (e) => this._data(new Uint8Array(e.data));
    ws.onclose = () => { this._down(); this._retry(); };
    ws.onerror = () => { try { ws.close(); } catch { /* closing anyway */ } };
  }

  publish(topic, payload) {
    if (!this.ready) return false;
    this.ws.send(mqttPacket(0x30, [...mqttStr(topic), ...payload]));
    return true;
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this._down();
    try { this.ws?.close(); } catch { /* already closed */ }
  }

  _down() {
    clearInterval(this.ping);
    if (this.ready) { this.ready = false; this.onChange(); }
  }

  _retry() {
    if (this.closed) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  // A WebSocket message can hold part of an MQTT packet, or several.
  _data(chunk) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf); b.set(chunk, this.buf.length);
    let i = 0;
    while (b.length - i >= 2) {
      let len = 0, mul = 1, j = i + 1, d;
      do { if (j >= b.length) { this.buf = b.slice(i); return; } d = b[j++]; len += (d & 127) * mul; mul *= 128; } while (d & 128);
      if (j + len > b.length) break;
      this._packet(b[i] >> 4, b.subarray(j, j + len));
      i = j + len;
    }
    this.buf = b.slice(i);
  }

  _packet(type, body) {
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { try { this.ws.close(); } catch { /* ignore */ } return; }
      this.ws.send(mqttPacket(0x82, [0, 1, ...mqttStr(this.topic), 0]));
    } else if (type === 9) { // SUBACK
      this.ready = true; this.backoff = 1000;
      this.ping = setInterval(() => { try { this.ws.send(new Uint8Array([0xc0, 0])); } catch { /* reconnects */ } }, (KEEPALIVE_S - 5) * 1000);
      this.onChange();
    } else if (type === 3) { // PUBLISH (QoS 0: topic, then payload)
      const tl = (body[0] << 8) | body[1];
      this.onPublish(body.subarray(2 + tl));
    }
  }
}

export class PublicRelay extends Emitter {
  constructor({ room, key, peer }) {
    super();
    this.room = room; this.key = key; this.peer = peer;
    this.state = 'idle';
    this.brokers = [];
    this.seen = new Set();
    this.ready = this._init();
  }

  async _init() {
    const raw = unb64url(this.key);
    this.aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`webrtc-studio|${this.room}|${this.key}`)));
    this.base = `wrtcstudio/v1/${[...h.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }

  async connect() {
    this.close(true);
    this._set('connecting');
    await this.ready;
    const topic = `${this.base}/${this.peer}`;
    this.brokers = MEET_BROKERS.map((u) => new Broker(u, topic, (p) => this._incoming(p), () => this._update()));
    for (const b of this.brokers) b.connect();
    // If none of them answers, say so (they keep retrying in the background).
    clearTimeout(this.giveUp);
    this.giveUp = setTimeout(() => { if (this.state !== 'open') this._set('error', 'No public meeting point is reachable.'); }, 12000);
  }

  async send(to, msg) {
    await this.ready;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = enc.encode(JSON.stringify({ ...msg, from: this.peer, id: b64url(crypto.getRandomValues(new Uint8Array(9))) }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.aes, plain));
    const payload = new Uint8Array(iv.length + ct.length);
    payload.set(iv); payload.set(ct, iv.length);
    let sent = 0;
    for (const b of this.brokers) if (b.publish(`${this.base}/${to}`, payload)) sent++;
    if (!sent) throw new Error('No public meeting point is reachable right now.');
  }

  close(quiet = false) {
    clearTimeout(this.giveUp);
    for (const b of this.brokers) b.close();
    this.brokers = [];
    if (!quiet) this._set('closed');
  }

  /** How many meeting points are connected, out of how many. */
  get reach() { return { up: this.brokers.filter((b) => b.ready).length, of: this.brokers.length }; }

  _update() {
    if (this.brokers.some((b) => b.ready)) this._set('open');
    else if (this.state === 'open') this._set('connecting');
    this.emit('reach', this.reach);
  }

  async _incoming(payload) {
    if (payload.length < 13) return;
    let msg;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.subarray(0, 12) }, this.aes, payload.subarray(12));
      msg = JSON.parse(dec.decode(plain));
    } catch { return; } // not ours, or tampered with
    if (!msg?.id || !msg.from || this.seen.has(msg.id)) return; // the same message arrives once per broker
    this.seen.add(msg.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    this.emit('message', msg);
  }

  _set(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state, detail);
  }
}
