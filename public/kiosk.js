// Front-desk kiosk (docs/22-KIOSK.md).
//  /kiosk#k=<kiosk key>  pairs this tablet (the key is kept in localStorage)
//  /kiosk                the paired tablet: sign in / walk-in / sign out + a QR code for phones
//  /kiosk#p=<pass>       a visitor's phone after scanning that QR code (valid 10 minutes, nothing stored)
// The kiosk can never show a door code or the visitor list. Every value from
// the server goes through esc().
(function () {
  const box = document.getElementById('box');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const show = html => { box.innerHTML = html; window.scrollTo(0, 0); };
  const $ = id => document.getElementById(id);
  const STORE = 'accessx.kiosk';
  const IDLE_MS = 60e3;
  const PASS_REFRESH_MS = 4 * 60e3; // passes live 10 minutes

  let auth = null;
  let phone = false;
  let info = null;
  let idle = null;
  let passTimer = null;
  let m;
  if ((m = location.hash.match(/^#k=(kx_[A-Za-z0-9_-]{32,64})$/))) {
    try { localStorage.setItem(STORE, m[1]); } catch (_) { /* private mode: works until reload */ }
    auth = { kiosk: m[1] };
    history.replaceState(null, '', location.pathname);
  } else if ((m = location.hash.match(/^#p=(p1\.[A-Za-z0-9._-]{20,200})$/))) {
    auth = { pass: m[1] };
    phone = true;
    document.body.classList.add('phone');
    history.replaceState(null, '', location.pathname);
  } else {
    let k = null;
    try { k = localStorage.getItem(STORE); } catch (_) { /* ignore */ }
    if (k) auth = { kiosk: k };
  }

  const call = (action, extra = {}) => fetch('/api/kiosk', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', cache: 'no-store',
    body: JSON.stringify({ ...auth, action, ...extra }),
  }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({ ok: false, error: `Error ${r.status}` }))) }))
    .catch(() => ({ ok: false, status: 0, error: 'No connection. Please try again, or ask reception.' }));

  function unpaired(msg) {
    clearTimeout(idle); clearInterval(passTimer);
    if (phone) {
      return show(`<h1>This code has expired</h1><p>${esc(msg || 'Please scan the code on the reception screen again.')}</p>`);
    }
    try { localStorage.removeItem(STORE); } catch (_) { /* ignore */ }
    show('<h1>This tablet is not paired</h1><p class="meta">In AccessX, go to <b>Visitors → Kiosks</b>, add a kiosk for this reception and open its pairing link (or scan its QR code) on this tablet.</p>');
  }
  if (!auth) return unpaired();

  function armIdle() {
    clearTimeout(idle);
    if (!phone) idle = setTimeout(home, IDLE_MS);
  }
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (idle) armIdle(); }, true));

  const noticeBlock = () => (info && info.notice
    ? `<div class="notice" tabindex="0">${esc(info.notice)}</div><label class="check"><input type="checkbox" id="accept"> <span>I have read the visitor notice and accept it.</span></label>`
    : '');
  const accepted = () => !info.notice || ($('accept') && $('accept').checked);
  const back = '<button class="link" id="back" type="button">← Back</button>';
  const bindBack = () => { const b = $('back'); if (b) b.addEventListener('click', home); };
  function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }

  function done(html) {
    show(`${html}${phone ? '' : '<button class="secondary" id="again" type="button">Done</button>'}`);
    if (!phone) { $('again').addEventListener('click', home); clearTimeout(idle); idle = setTimeout(home, 12e3); }
  }

  async function load() {
    const r = await call(phone ? 'info' : 'pass');
    if (r.status === 401) return unpaired();
    if (!r.ok) { show(`<h1>Visitor sign-in</h1><p class="bad">${esc(r.error)}</p><button id="retry">Try again</button>`); $('retry').addEventListener('click', load); return; }
    info = r;
    home();
    if (!phone) {
      clearInterval(passTimer);
      passTimer = setInterval(async () => {
        const n = await call('pass');
        if (n.status === 401) return unpaired();
        if (n.ok) { info = n; const q = $('qr'); if (q) q.innerHTML = qrSvg(); }
      }, PASS_REFRESH_MS);
    }
  }
  const qrSvg = () => (info && info.pass && window.AccessQR ? window.AccessQR.svg(`${location.origin}/kiosk#p=${info.pass}`, { size: 168 }) : '');

  function home() {
    clearTimeout(idle); idle = null;
    const where = [info.organisation, info.site].filter(Boolean).join(' · ');
    show(`<h1>Welcome</h1><div class="meta">${esc(where)}</div>
      <div class="grid">
        <button id="b-in" type="button">I have an invitation</button>
        <button id="b-walk" type="button" class="secondary">I don't have an invitation</button>
      </div>
      <div class="grid one"><button id="b-out" type="button" class="secondary">I'm leaving: sign out</button></div>
      ${phone ? '' : `<div class="qr"><div id="qr">${qrSvg()}</div><div><b>Or use your own phone</b><div class="meta">Scan this code with your camera. It works only here and for a few minutes.</div></div></div>`}`);
    $('b-in').addEventListener('click', checkin);
    $('b-walk').addEventListener('click', walkin);
    $('b-out').addEventListener('click', checkout);
  }

  function checkin() {
    armIdle();
    show(`<h2>Sign in with your invitation</h2>
      <form id="f" novalidate autocomplete="off">
        <label for="email">The email address your invitation was sent to</label>
        <input id="email" type="email" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="200" required>
        ${noticeBlock()}
        <p id="err" class="bad" role="alert"></p>
        <button id="go" type="submit">Sign in</button>
      </form>${back}`);
    bindBack();
    $('email').focus();
    $('f').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('err');
      if (!accepted()) { err.textContent = 'Please read and accept the visitor notice.'; return; }
      busy($('go'), true, 'Signing in…');
      const r = await call('checkin', { email: $('email').value, acceptNotice: accepted() });
      if (r.status === 401) return unpaired();
      if (!r.ok) {
        busy($('go'), false, 'Sign in');
        err.innerHTML = `${esc(r.error)}${r.status === 404 ? ' <button class="link" id="to-walk" type="button">I don\'t have an invitation</button>' : ''}`;
        if ($('to-walk')) $('to-walk').addEventListener('click', walkin);
        return;
      }
      done(`<div class="big ok" aria-hidden="true">✓</div><h1>Welcome${r.already ? ' back' : ''}!</h1>
        <p>${r.host ? `${esc(r.host)} knows you are here.` : 'Please take a seat; reception will be with you shortly.'}</p>
        <p class="meta">Use the door code from your invitation.</p>`);
    });
  }

  function walkin() {
    armIdle();
    show(`<h2>Sign in without an invitation</h2>
      <form id="f" novalidate autocomplete="off">
        <label for="name">Your name</label><input id="name" maxlength="100" autocapitalize="words" required>
        <label for="company">Company (optional)</label><input id="company" maxlength="100">
        <label for="host">Who are you here to see?</label><input id="host" maxlength="100" autocapitalize="words" placeholder="Full name">
        <label for="email">Your email (optional)</label><input id="email" type="email" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="200">
        ${noticeBlock()}
        <p id="err" class="bad" role="alert"></p>
        <button id="go" type="submit">Sign in</button>
      </form>${back}`);
    bindBack();
    $('name').focus();
    $('f').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('err');
      if (!$('name').value.trim()) { err.textContent = 'Please enter your name.'; return; }
      if (!accepted()) { err.textContent = 'Please read and accept the visitor notice.'; return; }
      busy($('go'), true, 'Signing in…');
      const r = await call('walkin', { name: $('name').value, company: $('company').value, host: $('host').value, email: $('email').value, acceptNotice: accepted() });
      if (r.status === 401) return unpaired();
      if (!r.ok) { busy($('go'), false, 'Sign in'); err.textContent = r.error; return; }
      done(`<div class="big ok" aria-hidden="true">✓</div><h1>Thank you</h1>
        <p>${r.host ? `We have told ${esc(r.host)} that you are here.` : 'Reception has been told that you are here.'} Please wait at reception.</p>`);
    });
  }

  function checkout() {
    armIdle();
    show(`<h2>Sign out</h2>
      <form id="f" novalidate autocomplete="off">
        <label for="email">The email address your invitation was sent to</label>
        <input id="email" type="email" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="200" required>
        <p id="err" class="bad" role="alert"></p>
        <button id="go" type="submit">Sign out</button>
      </form>
      <p class="meta">No invitation? Just let reception know you are leaving.</p>${back}`);
    bindBack();
    $('email').focus();
    $('f').addEventListener('submit', async e => {
      e.preventDefault();
      busy($('go'), true, 'Signing out…');
      const r = await call('checkout', { email: $('email').value });
      if (r.status === 401) return unpaired();
      if (!r.ok) { busy($('go'), false, 'Sign out'); $('err').textContent = r.error; return; }
      const pending = (r.pendingAtDoor || []).length;
      done(`<div class="big ok" aria-hidden="true">✓</div><h1>Goodbye, thank you for visiting</h1>
        <p>Your door code ${pending ? 'will be removed by reception' : 'has been switched off'}.</p>`);
    });
  }

  load();
})();
