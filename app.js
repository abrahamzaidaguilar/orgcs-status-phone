// The phone page. The link's fragment (#v=1&k=...&r=...&n=...) holds the secret; it never goes to a server.
(async () => {
  const $ = (id) => document.getElementById(id);
  const say = (text, error = false) => { $('msg').textContent = text; $('msg').className = 'msg' + (error ? ' error' : ''); };

  const link = Protocol.parseLink(location.href);
  if (!link) { say('This link is not valid. Open the one the browser showed you, complete.', true); return; }
  // Keep the secret out of history and out of anything shared from this tab.
  try { history.replaceState(null, '', location.pathname); } catch {}
  try { localStorage.setItem('orgcs-status-link', JSON.stringify(link)); } catch {}
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
