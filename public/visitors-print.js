/* Printable visitor list for a fire roll call or the end of the day (R16).
 * Uses the operator's browser session; every value goes through esc(). */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = t => (t ? new Date(t).toLocaleTimeString(window.axLocale||[], { hour: '2-digit', minute: '2-digit' }) : '—');
const get = url => fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json().then(b => ({ ok: r.ok, status: r.status, ...b }))).catch(() => ({ ok: false, error: 'No connection' }));
let data = null;

function table(head, rows) {
  if (!rows.length) return '<div class="meta">None.</div>';
  return `<table><tr><th></th>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map(r => `<tr><td class="box">☐</td>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
}

function render() {
  const site = $('#site').value;
  const now = Date.now();
  const inSite = x => !site || x.siteId === site;
  const visits = data.visits.filter(v => inSite(v) && v.status === 'scheduled' && !v.erased);
  const onSite = visits.filter(v => v.checkedInAt || v.arrivedAt);
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const expected = visits.filter(v => !v.checkedInAt && !v.arrivedAt && Date.parse(v.startAt) <= today.getTime() && Date.parse(v.endAt) >= now);
  const waiting = data.walkins.filter(w => inSite(w) && w.status === 'waiting');
  const who = v => `<b>${esc(v.visitorName)}</b>${v.company ? `<div class="meta">${esc(v.company)}</div>` : ''}`;
  $('#out').innerHTML = `
    <h2>On site now (${onSite.length + waiting.length})</h2>
    ${table(['Visitor', 'Host', 'Since', 'Site'], [
      ...onSite.map(v => [who(v), esc(v.hostName || ''), esc(time(v.checkedInAt || v.arrivedAt)) + (v.checkedInAt ? '' : '<div class="meta">opened a door</div>'), esc(v.siteName || '')]),
      ...waiting.map(w => [`<b>${esc(w.name)}</b>${w.company ? `<div class="meta">${esc(w.company)}</div>` : ''}`, esc(w.hostName || 'not matched'), `${esc(time(w.createdAt))}<div class="meta">walk-in, waiting at reception</div>`, esc(w.siteName || '')]),
    ])}
    <h2>Expected today, not signed in (${expected.length})</h2>
    ${table(['Visitor', 'Host', 'From', 'Site'], expected.map(v => [who(v), esc(v.hostName || ''), esc(time(v.startAt)), esc(v.siteName || '')]))}`;
  $('#sub').textContent = `${data.tenant || ''} · printed ${new Date().toLocaleString(window.axLocale)} by ${data.me || ''}`;
}

async function load() {
  const [v, w, me] = await Promise.all([get('/api/visits?range=current'), get('/api/walkins'), get('/api/me')]);
  if (!v.ok) { $('#out').innerHTML = `<p class="bad">${esc(v.status === 401 ? 'Sign in to AccessX in this browser first (as front desk or an administrator).' : v.error || 'Could not load visitors')}</p>`; $('#sub').textContent = ''; return; }
  data = { visits: v.visits || [], walkins: w.ok ? w.walkins : [], tenant: me.ok && me.tenant ? me.tenant.name : '', me: me.ok && me.operator ? me.operator.name : '' };
  const sites = new Map();
  for (const x of [...data.visits, ...data.walkins]) if (x.siteId) sites.set(x.siteId, x.siteName || x.siteId);
  const sel = $('#site');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All sites</option>' + [...sites].map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  sel.value = keep;
  render();
}
$('#site').addEventListener('change', () => data && render());
$('#print').addEventListener('click', () => window.print());
$('#reload').addEventListener('click', load);
load();
