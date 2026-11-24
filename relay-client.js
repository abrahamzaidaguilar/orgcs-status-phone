// A browser client for the relay (the same wire protocol as tools/pb-relay): binary frames over a WebSocket, a key
// proved by signing a challenge. Runs in Safari, Chrome and Node 22+ (it only needs WebSocket and Web Crypto with Ed25519).
// The relay only ever sees ciphertext from the messages built on top of this (see protocol.js); the key proved here
// just lets the connection in.
const RelayClient = (() => {
  const MAGIC = [0x48, 0x4d, 0x36, 0x34];
  const AUTH_TAG = 'satella-player-auth-v1:';
  const VERSION = '1.0.0';
  const JSON_FRAME = 0x02, RAW_FRAME = 0x03;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const fromHex = (text) => Uint8Array.from(text.match(/../g) || [], (h) => parseInt(h, 16));

  function frame(type, route, body = new Uint8Array(0)) {
    const r = enc.encode(route), out = new Uint8Array(9 + r.length + body.length);
    out.set(MAGIC); out[4] = type;
    new DataView(out.buffer).setUint32(5, r.length, true);
    out.set(r, 9); out.set(body, 9 + r.length);
    return out;
  }

  /** { reply: { status, body } } or { push: { kind, name, payload } } or null. */
  function parse(bytes) {
    if (bytes.length < 5 || bytes[0] !== 0x48 || bytes[1] !== 0x4d) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[2] !== 0x04) return { reply: { status: view.getInt16(3, true), body: bytes.slice(5) } };
    const rest = bytes.slice(5);
    if (rest.length < 3 + 32) return null;
    const nameLength = rest[1] | (rest[2] << 8);
    if (rest.length < 3 + nameLength + 32) return null;
    return { push: { kind: rest[0], name: dec.decode(rest.slice(3, 3 + nameLength)), payload: dec.decode(rest.slice(3 + nameLength + 32)) } };
  }

  class Client {
    /** `onMessage(channel, text)` for what arrives on channels you subscribed to; `onState('connecting'|'online'|'offline')`. */
    constructor({ host, onMessage = () => {}, onState = () => {} }) {
      Object.assign(this, { host: host.replace(/\/$/, ''), onMessage, onState, channels: new Set(), ws: null, waiting: [], queue: Promise.resolve(), stopped: false, delay: 1000, timer: null, keepalive: null });
    }

    async start() { this.stopped = false; return this.#connect(); }

    stop() { this.stopped = true; clearTimeout(this.timer); clearInterval(this.keepalive); this.ws?.close(); this.onState('offline'); }

    async #connect() {
      this.onState('connecting');
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const key = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
      const ws = new WebSocket(`${this.host}/ws?v=${VERSION}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      try {
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('connect')); });
        ws.onmessage = (e) => this.#received(new Uint8Array(e.data));
        ws.onclose = () => { clearInterval(this.keepalive); for (const w of this.waiting.splice(0)) w(null); this.onState('offline'); this.#retry(); };
        await this.#request(JSON_FRAME, `/v1/player/${key}/register`);
        const challenge = await this.#request(JSON_FRAME, '/v1/player/challenge');
        const nonce = JSON.parse(dec.decode(challenge.body)).nonce;
        const message = new Uint8Array([...enc.encode(AUTH_TAG), ...fromHex(nonce)]);
        const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, message));
        const verified = await this.#request(RAW_FRAME, `/v1/player/${key}/verify`, signature);
        if (!verified || verified.status !== 200) throw new Error('refused');
        for (const channel of this.channels) await this.#subscribe(channel);
        this.delay = 1000;
        this.keepalive = setInterval(() => { this.#request(JSON_FRAME, '/v1/player/challenge').catch(() => {}); }, 25_000);   // keeps a proxy from closing an idle connection
        this.onState('online');
      } catch (error) {
        try { ws.close(); } catch {}
        this.onState('offline');
        this.#retry();
      }
    }

    #retry() {
      if (this.stopped) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.#connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    }

    #request(type, route, body) {
      const run = () => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 10_000);
        this.waiting.push((reply) => { clearTimeout(timer); resolve(reply); });
        this.ws.send(frame(type, route, body));
      });
      const next = this.queue.then(run, run);
      this.queue = next.catch(() => {});
      return next;
    }

    #wire(channel) { return `${channel}@${VERSION}`; }

    async #subscribe(channel) {
      const reply = await this.#request(JSON_FRAME, `/v1/relay/${this.#wire(channel)}/subscribe`);
      if (!reply || reply.status !== 200) throw new Error('subscribe');
    }

    async subscribe(channel) {
      this.channels.add(channel);
      if (this.ws && this.ws.readyState === 1) await this.#subscribe(channel);
    }

    send(channel, text) { if (this.ws && this.ws.readyState === 1) this.ws.send(frame(RAW_FRAME, `/v1/relay/${this.#wire(channel)}/send`, enc.encode(text))); }

    #received(bytes) {
      const parsed = parse(bytes);
      if (!parsed) return;
      if (parsed.reply) { this.waiting.shift()?.(parsed.reply); return; }
      const { kind, name, payload } = parsed.push;
      if (kind !== 1) return;
      const channel = [...this.channels].find((c) => this.#wire(c) === name);
      if (channel) this.onMessage(channel, payload);
    }
  }

  return { Client, frame, parse };
})();
