// What the extension and the phone page say to each other, end to end encrypted: whoever runs the relay in the
// middle only carries ciphertext. Written for this project; the phone page loads this same file.
//
// Linking a phone makes a fresh 256-bit secret. It travels in the link's fragment (the part after #, which a browser
// never sends to a server) and is kept on the Mac and on that phone. Both sides derive from it the channel name and the
// message key. A message is AES-GCM encrypted; what it is bound to (channel and direction) is authenticated, so one
// sent by the Mac can't be played back to the Mac, and nobody without the secret can make one that opens. A message
// also carries a time and a random id, so an old one or a repeat is refused.
const Protocol = (() => {
  const VERSION = 1;
  const SKEW_MS = 5 * 60 * 1000;
  const enc = new TextEncoder(), dec = new TextDecoder();

  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (text) => {
    const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  const newSecret = () => b64u(crypto.getRandomValues(new Uint8Array(32)));

  async function hkdf(secretBytes, label, bits) {
    const base = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('orgcs-status-v1'), info: enc.encode(label) }, base, bits));
  }

  /** The channel and key for a secret. The channel name reveals nothing about the secret. */
  async function derive(secret) {
    const bytes = fromB64u(secret);
    if (bytes.length !== 32) throw new Error('The link secret is not valid.');
    const channel = 'os1.' + hex((await hkdf(bytes, 'channel', 128)));
    const key = await crypto.subtle.importKey('raw', await hkdf(bytes, 'message-key', 256), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { channel, key };
  }

  /** `direction` is 'p2m' (phone to Mac) or 'm2p'. Returns { text, id }: the text to put on the relay, and the id the message carries. */
  async function sealWithId(session, direction, message) {
    const id = b64u(crypto.getRandomValues(new Uint8Array(9)));
    const body = { ...message, v: VERSION, ts: Date.now(), id };
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(`${session.channel}|${direction}`) }, session.key, enc.encode(JSON.stringify(body))));
    const wire = new Uint8Array(nonce.length + cipher.length);
    wire.set(nonce); wire.set(cipher, nonce.length);
    return { text: b64u(wire), id };
  }

  const seal = async (session, direction, message) => (await sealWithId(session, direction, message)).text;

  /**
   * The message in `text`, or null when it doesn't open (wrong secret, wrong direction, altered), is too old or too far
   * ahead, or was seen before. `seen` is a Map kept by the caller; pass `now` to test.
   */
  async function open(session, direction, text, { seen = new Map(), now = Date.now() } = {}) {
    let message;
    try {
      const wire = fromB64u(text);
      if (wire.length < 12 + 16 || wire.length > 8192) return null;
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wire.slice(0, 12), additionalData: enc.encode(`${session.channel}|${direction}`) }, session.key, wire.slice(12));
      message = JSON.parse(dec.decode(plain));
    } catch { return null; }
    if (!message || message.v !== VERSION || typeof message.id !== 'string' || typeof message.ts !== 'number') return null;
    if (Math.abs(now - message.ts) > SKEW_MS) return null;
    for (const [id, at] of seen) if (now - at > SKEW_MS) seen.delete(id);
    if (seen.has(message.id)) return null;
    seen.set(message.id, now);
    return message;
  }

  /** The link to open on the phone. The secret is in the fragment, so no server ever receives it. */
  function link({ page, secret, relay, name }) {
    const params = new URLSearchParams({ v: String(VERSION), k: secret, r: relay });
    if (name) params.set('n', name);
    return `${page}#${params}`;
  }

  /** What a fragment (`location.hash`) carries, or null when it isn't a link. */
  function parseLink(fragment) {
    const params = new URLSearchParams(String(fragment || '').replace(/^#/, ''));
    const secret = params.get('k'), relay = params.get('r');
    if (params.get('v') !== String(VERSION) || !secret || !relay) return null;
    try { if (fromB64u(secret).length !== 32) return null; } catch { return null; }
    if (!/^wss?:\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[A-Za-z0-9._~\-\/]*)?$/.test(relay)) return null;
    return { secret, relay, name: (params.get('n') || '').slice(0, 32) };
  }

  return { VERSION, SKEW_MS, newSecret, derive, seal, sealWithId, open, link, parseLink, b64u, fromB64u };
})();
