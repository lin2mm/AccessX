// Visitor self check-out. The token is in the URL fragment (#…): browsers
// never send it to a server, so it is not in access logs or Referer headers.
// It is sent only in the body of the two POSTs below.
(function () {
  const box = document.getElementById('box');
  const token = decodeURIComponent(location.hash.slice(1));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const call = action => fetch('/api/visit-checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, action }), credentials: 'omit', cache: 'no-store',
  }).then(r => r.json().catch(() => ({ ok: false }))).catch(() => ({ ok: false, error: 'No connection. Please try again, or see reception.' }));
  const fail = msg => { box.innerHTML = `<h1 class="bad">Link not valid</h1><p>${esc(msg || 'This link is no longer valid. If you are still on site, please see reception.')}</p>`; };
  if (!token) return fail();
  // Drop the token from the address bar (history, screenshots).
  try { history.replaceState(null, '', location.pathname); } catch (_) { /* ignore */ }
  call('status').then(s => {
    if (!s.ok) return fail(s.error);
    box.innerHTML = `<h1>${esc(s.site || 'Your visit')}</h1>
      <div class="meta">Your access: ${esc(s.from)} → ${esc(s.until)}</div>
      <ul>${(s.doors || []).map(d => `<li>${esc(d)}</li>`).join('')}</ul>
      <p>Leaving? Check out and your door code stops working.</p>
      <button id="go" type="button">Check out now</button>`;
    document.getElementById('go').addEventListener('click', async e => {
      e.target.disabled = true; e.target.textContent = 'Checking out…';
      const r = await call('checkout');
      if (!r.ok) return fail(r.error);
      box.innerHTML = `<h1 class="ok">You are checked out</h1><p>Thank you for visiting. Your code no longer works${(r.pendingAtDoor || []).length ? ' at doors connected to the internet; reception will remove it from: ' + esc(r.pendingAtDoor.join(', ')) : ''}.</p>`;
    });
  });
})();
