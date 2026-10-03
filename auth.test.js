const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createAuthenticator } = require('./auth-core');
const { nodeSqliteAdapter, migrateNode } = require('./store/sqlite-node');
const { createStore, operatorStatement } = require('./store/repo');
const { sha256Hex } = require('./audit-core');

function memoryStore() {
  const sql = nodeSqliteAdapter(':memory:');
  migrateNode(sql, path.join(__dirname, 'migrations'));
  return createStore(sql);
}

function make(options = {}) {
  const store = options.store || memoryStore();
  const auth = createAuthenticator({ store, ...options });
  const call = ({ method = 'POST', token, ip = '127.0.0.1', path: p } = {}) => auth.authenticate({
    method,
    path: p || (method === 'GET' || method === 'HEAD' ? '/api/doors' : '/api/sites'),
    authorization: token ? `Bearer ${token}` : '',
    ip,
  });
  return { auth, call, store };
}
const status = r => (r.error ? r.error.status : 200);

test('allows public read-only requests when open reads are enabled', async () => {
  const { call } = make({ openReads: true });
  const r = await call({ method: 'GET' });
  assert.equal(r.operator.anonymous, true);
  assert.equal(r.tenantId, 't_default');
});

test('fails closed on writes and protected reads when nothing is configured', async () => {
  const { call } = make({ openReads: true });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await call({ method });
    assert.equal(status(r), 503);
    assert.match(r.error.body.error, /ADMIN_TOKEN/);
  }
  const locked = await make({ openReads: false }).call({ method: 'GET' });
  assert.equal(status(locked), 503);
  assert.match(locked.error.body.error, /API access/);
});

test('requires a valid bearer token; a wrong token is 401 even with open reads', async () => {
  const { call } = make({ adminToken: 'correct-token', openReads: true });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal(status(await call({ method, token: 'wrong-token' })), 401);
    assert.equal((await call({ method, token: 'correct-token' })).operator.role, 'r_owner');
  }
  assert.equal(status(await call({ method: 'GET', token: 'wrong-token' })), 401);
});

test('protects reads when openReads is disabled', async () => {
  const { call } = make({ adminToken: 'correct-token', openReads: false });
  assert.equal(status(await call({ method: 'GET' })), 401);
  assert.equal(status(await call({ method: 'GET', token: 'correct-token' })), 200);
});

test('rate-limits failed attempts without locking out a valid token', async () => {
  const { call } = make({ adminToken: 'correct-token', maxFails: 2 });
  assert.equal(status(await call({ token: 'wrong', ip: 'c' })), 401);
  assert.equal(status(await call({ token: 'wrong', ip: 'c' })), 429);
  assert.equal(status(await call({ token: 'correct-token', ip: 'c' })), 200);
  assert.equal(status(await call({ token: 'wrong', ip: 'c' })), 401);
});

test('operators stored in the database authenticate into their own tenant; revocation is immediate', async () => {
  const store = memoryStore();
  await store.createTenant('t_acme', 'Acme');
  const stmt = operatorStatement('t_acme', { id: 'op_1', name: 'Acme owner', role: 'r_owner', tokenSha256: sha256Hex('acme-token') });
  await store.sql.batch([stmt]);
  const { call } = make({ store, adminToken: 'default-owner' });

  const r = await call({ token: 'acme-token' });
  assert.equal(r.tenantId, 't_acme');
  assert.equal(r.operator.id, 'op_1');
  assert.equal('tokenSha256' in r.operator, false); // the hash never leaves auth
  assert.equal((await call({ token: 'default-owner' })).tenantId, 't_default');

  await store.sql.batch([{ sql: "UPDATE operators SET revoked_at = 'now' WHERE id = 'op_1'", params: [] }]);
  assert.equal(status(await call({ token: 'acme-token' })), 401);
});

test('the platform token only opens platform routes, and tenant tokens never do', async () => {
  const { call } = make({ adminToken: 'owner', platformToken: 'platform-secret' });
  assert.equal((await call({ method: 'POST', path: '/api/tenants', token: 'platform-secret' })).operator.platform, true);
  assert.equal(status(await call({ method: 'POST', path: '/api/tenants', token: 'owner' })), 401);
  assert.equal(status(await call({ method: 'POST', path: '/api/sites', token: 'platform-secret' })), 401);
  // not configured → the route does not exist
  assert.equal(status(await make({ adminToken: 'owner' }).call({ method: 'POST', path: '/api/tenants', token: 'owner' })), 404);
});

test('reports read-only and locked auth states accurately', () => {
  const store = memoryStore();
  assert.equal(createAuthenticator({ store, openReads: true }).status().mode, 'DEMO-READ-ONLY');
  assert.equal(createAuthenticator({ store, openReads: false }).status().mode, 'LOCKED');
  const configured = createAuthenticator({ store, adminToken: 'configured' }).status();
  assert.equal(configured.mode, 'TOKEN');
  assert.equal(configured.tokenConfigured, true);
});

test('sessions expire after inactivity and at their absolute lifetime', async () => {
  const store = memoryStore();
  await store.sql.batch([{ sql: "INSERT OR IGNORE INTO tenants (id, name) VALUES ('t_default', 'Default')", params: [] }]);
  let clock = Date.parse('2026-09-27T00:00:00Z');
  const auth = createAuthenticator({ store, adminToken: 'owner', now: () => clock, sessionIdleMs: 60 * 60e3, sessionTtlMs: 12 * 3600e3 });
  const start = await auth.login({ token: 'owner' });
  const cookie = `ax_session=${start.cookieValue}`;
  const read = () => auth.authenticate({ method: 'GET', path: '/api/doors', cookie });

  clock += 50 * 60e3; assert.equal((await read()).operator.id, 'owner');   // active use slides the idle window
  clock += 50 * 60e3; assert.equal((await read()).operator.id, 'owner');
  clock += 61 * 60e3; assert.ok((await read()).error, 'idle timeout');
  const again = await auth.login({ token: 'owner' });
  const c2 = `ax_session=${again.cookieValue}`;
  for (let i = 0; i < 14; i++) { clock += 55 * 60e3; await auth.authenticate({ method: 'GET', path: '/api/doors', cookie: c2 }); }
  assert.ok((await auth.authenticate({ method: 'GET', path: '/api/doors', cookie: c2 })).error, 'absolute lifetime (12h) reached');
});

test('cookie sessions need the CSRF token for writes; bearer tokens do not', async () => {
  const store = memoryStore();
  await store.sql.batch([{ sql: "INSERT OR IGNORE INTO tenants (id, name) VALUES ('t_default', 'Default')", params: [] }]);
  const auth = createAuthenticator({ store, adminToken: 'owner' });
  const s = await auth.login({ token: 'owner' });
  const cookie = `ax_session=${s.cookieValue}`;
  assert.equal(status(await auth.authenticate({ method: 'POST', path: '/api/sites', cookie })), 403);
  assert.equal(status(await auth.authenticate({ method: 'POST', path: '/api/sites', cookie, csrf: 'wrong' })), 403);
  assert.equal(status(await auth.authenticate({ method: 'POST', path: '/api/sites', cookie, csrf: s.csrf })), 200);
  assert.equal(status(await auth.authenticate({ method: 'POST', path: '/api/sites', authorization: 'Bearer owner' })), 200);
});
