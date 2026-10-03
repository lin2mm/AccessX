// Visitor pre-registration. The token is in the URL fragment (#…): browsers
// never send it to a server, so it is not in access logs or Referer headers.
// It is sent only in the body of the POSTs below. The page never receives a
// door code: the code is sent to the address the host chose.
(function () {
  const box = document.getElementById('box');
  const token = decodeURIComponent(location.hash.slice(1));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const call = body => fetch('/api/visit-invite', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }), credentials: 'omit', cache: 'no-store',
  }).then(r => r.json().catch(() => ({ ok: false }))).catch(() => ({ ok: false, error: 'No connection. Please try again.' }));
  const fail = msg => { box.innerHTML = `<h1 class="bad">Invitation not valid</h1><p>${esc(msg || 'This invitation is no longer valid. Please contact your host.')}</p>`; };
  if (!token) return fail();
  try { history.replaceState(null, '', location.pathname); } catch (_) { /* ignore */ }
  // Local wall-clock strings ("2026-10-02T09:00"): step whole hours (TTLock codes run on hours).
  const toMs = s => Date.parse(`${s}:00Z`);
  const fromMs = ms => new Date(ms).toISOString().slice(0, 16);
  const pretty = s => new Date(toMs(s)).toLocaleString(window.axLocale, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  call({ action: 'status' }).then(s => {
    if (!s.ok) return fail(s.error);
    const opts = [];
    for (let t = toMs(s.startLocal) + 3600e3; t < toMs(s.endLocal); t += 3600e3) opts.push(fromMs(t));
    box.innerHTML = `<h1>${esc(s.site || 'Your visit')}</h1>
      <div class="meta">${s.host ? esc(s.host) + ' invited you · ' : ''}${esc(pretty(s.startLocal))} → ${esc(pretty(s.endLocal))} <span title="${esc(s.timeZone)}">(local time)</span></div>
      <ul>${(s.doors || []).map(d => `<li>${esc(d)}</li>`).join('')}</ul>
      <form id="f" autocomplete="on">
        <label for="n">Your name</label><input id="n" name="name" autocomplete="name" required maxlength="100">
        <label for="c">Company (optional)</label><input id="c" name="organization" autocomplete="organization" maxlength="100">
        <label for="a">Arriving</label><select id="a"><option value="">${esc(pretty(s.startLocal))} (start)</option>${opts.map(o => `<option value="${esc(o)}">${esc(pretty(o))}</option>`).join('')}</select>
        <p class="meta">Your door code will be sent to <b>${esc(s.sendTo)}</b>${s.requireApproval ? ' once reception has approved your visit' : ''}.</p>
        <button id="go" type="submit">Register</button>
      </form>`;
    document.getElementById('f').addEventListener('submit', async e => {
      e.preventDefault();
      const go = document.getElementById('go');
      go.disabled = true; go.textContent = 'Registering…';
      const r = await call({ action: 'submit', name: document.getElementById('n').value, company: document.getElementById('c').value, startLocal: document.getElementById('a').value || undefined });
      if (!r.ok) {
        if (r.error && !/no longer/.test(r.error)) { go.disabled = false; go.textContent = 'Register'; alertBox(r.error); return; }
        return fail(r.error);
      }
      box.innerHTML = r.pending
        ? `<h1 class="ok">Thank you</h1><p>Reception will review your visit. Once approved, your door code is sent to <b>${esc(r.sentTo)}</b>.</p>`
        : `<h1 class="ok">You are registered</h1><p>Your door code has been sent to <b>${esc(r.sentTo)}</b>. It works only during your visit.</p>`;
    });
  });
  function alertBox(msg) {
    let p = document.getElementById('err');
    if (!p) { p = document.createElement('p'); p.id = 'err'; p.className = 'bad'; document.getElementById('f').appendChild(p); }
    p.textContent = msg;
  }
})();
