// Self-service signup (docs/21-SIGNUP.md).
//  /signup                → form → "check your inbox"
//  /signup#t=<token>      → the emailed link: creates the account, shows the
//                           owner's sign-in key ONCE, then signs in.
// The token is in the fragment, so browsers never send it to a server (no
// access logs, no Referer); it travels only in a POST body.
(function () {
  const box = document.getElementById('box');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' })
    .then(r => r.json().catch(() => ({ ok: false, error: `Error ${r.status}` }))).catch(() => ({ ok: false, error: 'No connection. Please try again.' }));
  const show = html => { box.innerHTML = html; };
  const token = (location.hash.match(/^#t=([A-Za-z0-9_-]+)$/) || [])[1];
  if (token) {
    try { history.replaceState(null, '', location.pathname); } catch (_) { /* ignore */ }
    return verify(token);
  }
  fetch('/api/signup', { cache: 'no-store' }).then(r => r.json()).catch(() => ({})).then(info => {
    if (!info.enabled) {
      return show('<h1>Accounts are created on request</h1><p>Self-service signup is not open on this server. Please contact us and we will set up your account.</p><p class="meta"><a href="/">Back to sign-in</a></p>');
    }
    form(info);
  });

  function form(info) {
    let zone = 'UTC';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { /* old browser */ }
    const zones = (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [zone, 'UTC']);
    if (!zones.includes(zone)) zones.unshift(zone);
    show(`<h1>Create your AccessX account</h1>
      <p class="meta">For your office's doors: people, schedules, visitors and an audit trail. Free while we pilot${info.billing ? '; subscribe later from Settings' : ''}.</p>
      <form id="f" autocomplete="on" novalidate>
        <label for="company">Company</label><input id="company" autocomplete="organization" required maxlength="100">
        <label for="name">Your name</label><input id="name" autocomplete="name" required maxlength="100">
        <label for="email">Work email</label><input id="email" type="email" autocomplete="email" required maxlength="254">
        <label for="tz">Time zone of your office</label>
        <select id="tz">${zones.map(z => `<option${z === zone ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select>
        <div class="trap" aria-hidden="true"><label for="website">Leave empty</label><input id="website" tabindex="-1" autocomplete="off"></div>
        <label class="check"><input type="checkbox" id="terms"> <span>I accept the ${info.termsUrl ? `<a href="${esc(info.termsUrl)}" target="_blank" rel="noopener">terms of service</a>` : 'terms of service'} and confirm I may set up door access for this company.</span></label>
        <p id="err" class="bad" role="alert"></p>
        <button id="go" type="submit">Email me a confirmation link</button>
      </form>
      <p class="meta">Already have an account? <a href="/">Sign in</a></p>`);
    document.getElementById('f').addEventListener('submit', async e => {
      e.preventDefault();
      const v = id => document.getElementById(id).value;
      const err = document.getElementById('err');
      const go = document.getElementById('go');
      go.disabled = true; go.textContent = 'Sending…'; err.textContent = '';
      const r = await post('/api/signup', { company: v('company'), name: v('name'), email: v('email'), timeZone: v('tz'), website: v('website'), acceptTerms: document.getElementById('terms').checked });
      if (!r.ok) { go.disabled = false; go.textContent = 'Email me a confirmation link'; err.textContent = r.error || 'Something went wrong. Please try again.'; return; }
      show(`<h1 class="ok">Check your inbox</h1><p>${esc(r.message)}</p><p class="meta">Sent to <b>${esc(v('email'))}</b>. Nothing arrived after a few minutes? Check spam, or <a href="/signup">try again</a>.</p>`);
    });
  }

  async function verify(t) {
    show('<h1>Creating your account…</h1>');
    const r = await post('/api/signup/verify', { token: t });
    if (!r.ok) return show(`<h1 class="bad">Link not valid</h1><p>${esc(r.error)}</p><p class="meta"><a href="/signup">Start again</a></p>`);
    const key = r.owner.token;
    show(`<h1 class="ok">${esc(r.tenant.name)} is ready</h1>
      <p>This is your <b>sign-in key</b>. It is shown <b>only now</b>: save it in your password manager.</p>
      <div class="key" id="key">${esc(key)}</div>
      <button class="secondary" id="copy" type="button">Copy</button>
      <button class="secondary" id="dl" type="button">Download as a text file</button>
      <label class="check"><input type="checkbox" id="saved"> <span>I have saved my sign-in key.</span></label>
      <button id="open" type="button" disabled>Open AccessX</button>
      <p class="meta">Next, AccessX's <b>Get started</b> list walks you through connecting your TTLock account and setting up your office (about 45 minutes). Later you can switch to single sign-on and invite colleagues with their own keys.</p>`);
    document.getElementById('copy').addEventListener('click', async e => {
      try { await navigator.clipboard.writeText(key); e.target.textContent = 'Copied'; } catch (_) { e.target.textContent = 'Select the key and copy it'; }
    });
    document.getElementById('dl').addEventListener('click', () => {
      const text = `AccessX sign-in key for ${r.tenant.name}\nAccount owner: ${r.owner.name}\n\n${key}\n\nSign in at ${location.origin}/ . Keep this file private.\n`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = 'accessx-sign-in-key.txt';
      document.body.appendChild(a); a.click(); a.remove();
    });
    // The key cannot be shown again: warn before leaving until it is saved.
    const guard = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    document.getElementById('saved').addEventListener('change', e => {
      document.getElementById('open').disabled = !e.target.checked;
      if (e.target.checked) window.removeEventListener('beforeunload', guard); else window.addEventListener('beforeunload', guard);
    });
    document.getElementById('open').addEventListener('click', async e => {
      e.target.disabled = true; e.target.textContent = 'Signing in…';
      const s = await post('/api/auth/login', { token: key });
      if (!s.ok) { e.target.disabled = false; e.target.textContent = 'Open AccessX'; return; }
      location.href = '/';
    });
  }
})();
