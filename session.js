// The phone's side of a linked session, with no screen: connect, ask for the state, ask for a status. The page (app.js)
// draws it. Needs protocol.js and relay-client.js.
const PhoneSession = (() => {
  const TIMEOUT_MS = 20_000;

  /** `link` is what Protocol.parseLink returned: { secret, relay, name }. */
  async function create(link, { onState = () => {}, onConnection = () => {} } = {}) {
    const session = await Protocol.derive(link.secret);
    const seen = new Map();
    const pending = new Map();        // message id -> resolve
    let last = null;

    const client = new RelayClient.Client({
      host: link.relay,
      onState: (s) => onConnection(s),
      onMessage: async (channel, text) => {
        if (channel !== session.channel) return;
        const message = await Protocol.open(session, 'm2p', text, { seen });
        if (!message) return;
        if (message.type === 'state') { last = message; onState(message); }
        if (message.inReplyTo && pending.has(message.inReplyTo)) { pending.get(message.inReplyTo)(message); pending.delete(message.inReplyTo); }
      },
    });
    await client.subscribe(session.channel);

    async function ask(message) {
      const { text, id } = await Protocol.sealWithId(session, 'p2m', message);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, TIMEOUT_MS);
        pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
        client.send(session.channel, text);
      });
    }

    return {
      channel: session.channel,
      start: () => client.start(),
      stop: () => client.stop(),
      state: () => last,
      /** Asks the Mac for its statuses and the current one. Resolves with the 'state' message, or null if it didn't answer. */
      list: () => ask({ type: 'list' }),
      /** Asks the Mac to switch. Resolves with the 'result' message, or null if it didn't answer. */
      set: (status) => ask({ type: 'set', status }),
    };
  }

  return { create };
})();
