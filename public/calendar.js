// R17: the meeting organiser confirms which calendar guests get a visitor invitation
// (docs/23-CALENDAR.md). The token is in the URL fragment (#t=…): browsers never
// send it to a server, so it is not in logs or Referer; it goes only in POST bodies.
// Nothing here issues a code: each chosen guest gets the normal invitation email.
(function () {
  const box = document.getElementById('box');
  const token = decodeURIComponent((location.hash.match(/[#&]t=([^&]+)/) || [])[1] || '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const call = body => fetch('/api/calendar-confirm', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }), credentials: 'omit', cache: 'no-store',
  }).then(r => r.json().catch(() => ({ ok: false }))).catch(() => ({ ok: false, error: 'No connection. Please try again.' }));
  const fail = msg => { box.innerHTML = `<h1 class="bad">Link not valid</h1><p>${esc(msg || 'This link has already been used or has expired.')}</p>`; };
  if (!token) return fail();
  try { history.replaceState(null, '', location.pathname); } catch (_) { /* ignore */ }

  call({ action: 'info' }).then(s => {
    if (!s.ok) return fail(s.error);
    if (!s.offices || !s.offices.length) return fail('Calendar invitations are switched off. Ask your administrator.');
    const office = id => s.offices.find(o => o.siteId === id) || s.offices[0];
    // Labels look like "2026-10-05 10:00 Europe/London": show the end's date only when it differs.
    const when = o => {
      const [fd, ft, tz] = o.from.split(' '); const [ud, ut] = o.until.split(' ');
      return `${esc(fd)} ${esc(ft)} – ${ud === fd ? '' : esc(ud) + ' '}${esc(ut)} <span class="meta">(${esc(tz)})</span>`;
    };
    box.innerHTML = `<h1>${esc(s.summary || 'Your meeting')}</h1>
      <div class="meta">${s.organisation ? esc(s.organisation) + ' · ' : ''}${s.location ? esc(s.location) : ''}</div>
      <p id="when">${when(office(s.suggestedSiteId))}</p>
      ${s.tzAssumed ? '<div class="warn">We could not read the meeting\'s time zone and used the office time. Check the time above.</div>' : ''}
      ${s.recurring ? '<div class="warn">This is a recurring meeting: invitations are for the <b>first</b> occurrence only.</div>' : ''}
      <form id="f">
        ${s.offices.length > 1 ? `<label for="site">Office</label><select id="site">${s.offices.map(o => `<option value="${esc(o.siteId)}"${o.siteId === s.suggestedSiteId ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select>` : `<input type="hidden" id="site" value="${esc(s.offices[0].siteId)}"><p class="meta">${esc(s.offices[0].name)}</p>`}
        <p class="meta" id="doors">Doors: ${esc(office(s.suggestedSiteId).doors.join(', '))}</p>
        <label>Send a visitor invitation to</label>
        ${s.guests.map((g, i) => `<label class="guest"><input type="checkbox" name="g" value="${esc(g.email)}" checked id="g${i}"><span>${g.name ? esc(g.name) + '<br>' : ''}<span class="meta">${esc(g.email)}</span></span></label>`).join('')}
        <p class="meta">Each guest gets an email to register their name; their door code is sent to that address only, for the meeting time.</p>
        <button type="submit" id="go">Send invitations</button>
        <button type="button" class="secondary" id="no">Not needed</button>
      </form>`;
    const siteEl = document.getElementById('site');
    siteEl.addEventListener('change', () => {
      const o = office(siteEl.value);
      document.getElementById('when').innerHTML = when(o);
      document.getElementById('doors').textContent = `Doors: ${o.doors.join(', ')}`;
    });
    document.getElementById('no').addEventListener('click', async () => {
      const r = await call({ action: 'decline' });
      box.innerHTML = r.ok ? '<h1>Done</h1><p>No invitations were sent.</p>' : `<h1 class="bad">Something went wrong</h1><p>${esc(r.error || 'Please try again.')}</p>`;
    });
    document.getElementById('f').addEventListener('submit', async e => {
      e.preventDefault();
      const guests = [...document.querySelectorAll('input[name=g]:checked')].map(x => x.value);
      if (!guests.length) { alert('Choose at least one guest, or press "Not needed".'); return; }
      const go = document.getElementById('go');
      go.disabled = true; go.textContent = 'Sending…';
      const r = await call({ action: 'confirm', siteId: siteEl.value, guests });
      if (!r.ok) { go.disabled = false; go.textContent = 'Send invitations'; box.insertAdjacentHTML('beforeend', `<p class="bad">${esc(r.error || 'Please try again.')}</p>`); return; }
      box.innerHTML = `<h1 class="ok">Invitations sent</h1>
        ${r.sent.length ? `<ul>${r.sent.map(x => `<li>${esc(x.email)}</li>`).join('')}</ul>` : ''}
        ${r.failed.length ? `<p class="bad">Not sent:</p><ul>${r.failed.map(x => `<li>${esc(x.email)}: ${esc(x.error)}</li>`).join('')}</ul><p class="meta">Reception can invite them from the Visitors page.</p>` : ''}
        <p class="meta">If the meeting moves, you will get a new link. If it is cancelled, unused invitations are withdrawn.</p>`;
    });
  });
})();
