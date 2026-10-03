const assert = require('node:assert/strict');
const test = require('node:test');
const { boot } = require('../support/boot');

const cookieFrom = r => r.cookies.map(c => c.split(';')[0]).join('; ');

test('browser sessions: token → HttpOnly cookie, CSRF on writes, logout', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);

  assert.equal((await api.call('POST', '/api/auth/login', { body: { token: 'nope' } })).status, 401);
  const login = await api.call('POST', '/api/auth/login', { body: { token: 'owner-token' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.operator.role, 'r_owner');
  assert.match(login.body.csrf, /^[0-9a-f]{32}$/);
  const [setCookie] = login.cookies;
  assert.match(setCookie, /^ax_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200/);
  assert.doesNotMatch(JSON.stringify(login.body), /owner-token/);

  const cookie = cookieFrom(login);
  const raw = cookie.split('=')[1];
  // Only the hash is stored.
  const { sql } = api.server.store;
  assert.deepEqual(await sql.all('SELECT 1 FROM sessions WHERE id_sha256 = ?', [raw]), []);
  assert.equal((await sql.all('SELECT via FROM sessions')).length, 1);

  // Reads work with the cookie alone …
  const me = await api.call('GET', '/api/me', { headers: { cookie } });
  assert.equal(me.body.operator.id, 'owner');
  const session = await api.call('GET', '/api/auth/session', { headers: { cookie } });
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.csrf, login.body.csrf);

  // … writes also need the CSRF token (a cross-site form cannot know it).
  const noCsrf = await api.call('POST', '/api/holidays', { headers: { cookie }, body: { date: '2027-05-01', name: 'x' } });
  assert.equal(noCsrf.status, 403);
  assert.match(noCsrf.body.error, /CSRF/);
  const withCsrf = await api.call('POST', '/api/holidays', { headers: { cookie, 'x-csrf-token': login.body.csrf }, body: { date: '2027-05-01', name: 'x' } });
  assert.equal(withCsrf.status, 200);

  // Logins are audited (method only, no secrets).
  const log = await api.call('GET', '/api/audit?action=operator.login', { token: 'owner-token' });
  assert.equal(log.body.log[0].detail, 'via token');

  // Logout needs CSRF too, then the cookie is dead.
  assert.equal((await api.call('POST', '/api/auth/logout', { headers: { cookie } })).status, 403);
  const out = await api.call('POST', '/api/auth/logout', { headers: { cookie, 'x-csrf-token': login.body.csrf } });
  assert.match(out.cookies[0], /Max-Age=0/);
  assert.equal((await api.call('GET', '/api/auth/session', { headers: { cookie } })).body.authenticated, false);
  assert.equal((await api.call('POST', '/api/holidays', { headers: { cookie, 'x-csrf-token': login.body.csrf }, body: { date: '2027-05-02', name: 'y' } })).status, 401);
});

test('revoking an operator ends their browser sessions immediately', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const made = await api.call('POST', '/api/operators', { token: 'owner-token', body: { name: 'Temp', role: 'r_view' } });
  const login = await api.call('POST', '/api/auth/login', { body: { token: made.body.token } });
  const cookie = cookieFrom(login);
  assert.equal((await api.call('GET', '/api/doors', { headers: { cookie } })).body.doors.length, 7);
  await api.call('DELETE', `/api/operators/${made.body.operator.id}`, { token: 'owner-token' });
  assert.equal((await api.call('GET', '/api/auth/session', { headers: { cookie } })).body.authenticated, false);
  assert.equal((await api.call('GET', '/api/me', { headers: { cookie } })).status, 401);
});

test('behind HTTPS the cookie uses the __Host- prefix and Secure', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const login = await api.call('POST', '/api/auth/login', { body: { token: 'owner-token' }, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(login.cookies[0], /^__Host-ax_session=.*; Secure$/);
});
