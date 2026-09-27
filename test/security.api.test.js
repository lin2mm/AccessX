const assert = require('node:assert/strict');
const test = require('node:test');
const { boot } = require('../support/boot');

test('stored XSS payloads never reach the copilot unescaped', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const owner = { token: 'owner-token' };
  const payload = '<img src=x onerror=alert(1)>';
  const created = await api.call('POST', '/api/users', { ...owner, body: { name: payload, groupIds: ['ug_it'], suspended: true } });
  assert.equal(created.status, 200); // names may contain < — they are data, escaped on output
  const answer = await api.call('POST', '/api/ai', { ...owner, body: { q: 'anything unusual?' } });
  assert.equal(answer.body.answer.includes(payload), false);
  assert.match(answer.body.answer, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('invalid records are rejected with a reason', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const bad = await api.call('POST', '/api/schedules', { token: 'owner-token', body: { name: 'Broken', windows: [{ from: '09:00' }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /days/);
  const extra = await api.call('POST', '/api/users', { token: 'owner-token', body: { name: 'x', role: 'r_owner' } });
  assert.equal(extra.status, 400);
});

test('deleting referenced records is refused', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const res = await api.call('DELETE', '/api/schedules/sch_office', { token: 'owner-token' });
  assert.equal(res.status, 409);
  assert.ok(res.body.referencedBy.length > 0);
  assert.equal((await api.call('DELETE', '/api/schedules/nope', { token: 'owner-token' })).status, 404);
});

test('security headers are set on pages and API', async t => {
  const api = await boot({});
  t.after(api.close);
  const page = await fetch(api.base + '/');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const html = await page.text();
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers in index.html');
  assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline scripts');
  const apiRes = await fetch(api.base + '/api/auth');
  assert.equal(apiRes.headers.get('cache-control'), 'no-store');
});

test('clickjacking: pages may only be framed by their own origin (R22)', async t => {
  const api = await boot({});
  t.after(api.close);
  const page = await fetch(api.base + '/');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'(;|$)/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  // Cloudflare serves the pages from public/_headers: same policy there.
  const hdr = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', '_headers'), 'utf8');
  assert.match(hdr, /Content-Security-Policy:[^\n]*frame-ancestors 'self'/);
  assert.match(hdr, /X-Frame-Options: SAMEORIGIN/);
  // Signup adds Turnstile to the policy and must keep frame-ancestors.
  const { withTurnstile } = require('../signup-core');
  assert.match(withTurnstile(page.headers.get('content-security-policy')), /frame-ancestors 'self'/);
});

test('FRAME_ANCESTORS widens framing only to a valid origin list; the doctor flags *', async t => {
  const wide = await boot({ FRAME_ANCESTORS: 'https://intranet.example.com' });
  t.after(wide.close);
  const res = await fetch(wide.base + '/');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors https:\/\/intranet\.example\.com(;|$)/);
  assert.equal(res.headers.get('x-frame-options'), null);
  const junk = await boot({ FRAME_ANCESTORS: "https://a.example.com; script-src *" });
  t.after(junk.close);
  assert.match((await fetch(junk.base + '/')).headers.get('content-security-policy'), /frame-ancestors 'self'$/, 'malformed value falls back to self');
  const { checkConfig } = require('../doctor-core');
  const find = (env, o) => checkConfig(env, o).find(c => c.id === 'FRAME_ANCESTORS');
  assert.equal(find({ FRAME_ANCESTORS: '*' }).level, 'error');
  assert.equal(find({ FRAME_ANCESTORS: 'https://intranet.example.com' }).level, 'warn');
  assert.equal(find({ FRAME_ANCESTORS: 'https://x.example.com' }, { runtime: 'worker' }).level, 'warn');
  assert.equal(find({}), undefined);
});
