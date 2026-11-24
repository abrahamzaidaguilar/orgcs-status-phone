// The phone page. The link's fragment (#v=1&k=...&r=...&n=...) holds the secret; it never goes to a server.
(async () => {
  const $ = (id) => document.getElementById(id);
  const say = (text, error = false) => { $('msg').textContent = text; $('msg').className = 'msg' + (error ? ' error' : ''); };

  // The link comes in the fragment. It stays in the address bar on purpose: "Add to Home Screen" and bookmarks save the
  // address, so they keep the link. The fragment never goes to a server. A copy is kept in this browser's storage, so
  // opening the page without the fragment (a reload of a stripped address) still works there.
  let link = Protocol.parseLink(location.hash);
  if (link) { try { localStorage.setItem('orgcs-status-link', JSON.stringify(link)); } catch {} }
  else { try { const s = JSON.parse(localStorage.getItem('orgcs-status-link')); link = Protocol.parseLink(Protocol.link({ page: '', secret: s.secret, relay: s.relay, name: s.name })); } catch { link = null; } }
  if (!link) { say('This link is not valid. Open the one the browser showed you, complete.', true); return; }
  $('who').textContent = link.name ? `Linked as ${link.name}` : '';

  let busy = false;
  function draw(state) {
    $('current').textContent = state.current || 'Unknown';
    const list = $('list'); list.replaceChildren();
    for (const status of state.statuses || []) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = status; b.disabled = busy;
      if (status === state.current) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => choose(status));
      list.append(b);
    }
  }

  const session = await PhoneSession.create(link, {
    onState: draw,
    onConnection: (s) => { const on = s === 'online'; $('dot').className = 'dot' + (on ? ' on' : ''); $('conn').textContent = on ? 'Connected · ' : 'Reconnecting… '; },
  });

  async function choose(status) {
    busy = true; say('Changing to ' + status + '…'); draw(session.state() || { statuses: [] });
    const reply = await session.set(status);
    busy = false;
    if (!reply) say('Your Mac did not answer. Is the browser open on an OrgCS page?', true);
    else say(reply.message || (reply.ok ? 'Done.' : 'It did not work.'), !reply.ok);
    if (session.state()) draw(session.state());
  }

  await session.start();
  const first = await session.list();
  if (first) draw(first); else say('Your Mac did not answer yet. Open the browser on an OrgCS page.', true);
})();
