#!/usr/bin/env node
// Smoke-test a running Worker (wrangler dev) with the same RBAC scenarios
// as the Express tests. Usage:
//   BASE=http://127.0.0.1:8787 OWNER=owner-token GYM=gym-token AUDIT=audit-token PLATFORM=platform-token node support/worker-smoke.js
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const call = async (method, url, token, body) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const { OWNER, GYM, AUDIT, PLATFORM } = process.env;

check('public auth status', async () => {
  const r = await call('GET', '/api/auth');
  assert.equal(r.status, 200);
  assert.ok(r.body.operatorsConfigured >= 1);
});
check('anonymous may read doors (demo open reads)', async () => {
  assert.equal((await call('GET', '/api/doors')).status, 200);
});
check('anonymous cannot unlock', async () => {
  assert.equal((await call('POST', '/api/doors/9001/unlock', null, {})).status, 401);
});
check('gym manager sees only gym doors', async () => {
  const r = await call('GET', '/api/doors', GYM);
  assert.deepEqual(r.body.doors.map(d => d.lockId).sort(), [9101, 9102]);
});
check('gym manager cannot unlock office doors', async () => {
  assert.equal((await call('POST', '/api/doors/9002/unlock', GYM, {})).status, 403);
  assert.equal((await call('POST', '/api/doors/9101/unlock', GYM, { reason: 'delivery' })).status, 200);
});
check('operator override unlock requires a reason', async () => {
  assert.equal((await call('POST', '/api/doors/9101/unlock', GYM, {})).status, 400);
});
check('legacy D1 state was migrated into rows with its audit chain', async () => {
  const log = await call('GET', '/api/audit?limit=1000', OWNER);
  const seeded = log.body.log.find(e => e.action === 'tenant.seeded');
  assert.ok(seeded, 'tenant.seeded present');
  if (process.env.EXPECT_LEGACY) {
    assert.match(seeded.detail, /legacy app_state blob/);
    assert.ok(log.body.log.some(e => e.action === 'userGroups.site_inferred'));
    assert.ok(seeded.seq > Number(process.env.EXPECT_LEGACY));
  }
});
check('gym manager sees and manages only gym people', async () => {
  const r = await call('GET', '/api/users', GYM);
  assert.deepEqual(r.body.users.map(u => u.id), ['u4']);
  assert.equal((await call('POST', '/api/users/u1/suspend', GYM)).status, 404);
  assert.equal((await call('POST', '/api/users', GYM, { name: 'Office person', groupIds: ['ug_staff'] })).status, 403);
});
check('gym manager cannot edit rules', async () => {
  assert.equal((await call('POST', '/api/schedules', GYM, { name: 'x' })).status, 403);
});
check('auditor reads audit, cannot unlock', async () => {
  assert.equal((await call('GET', '/api/audit', AUDIT)).status, 200);
  assert.equal((await call('POST', '/api/doors/9001/unlock', AUDIT, {})).status, 403);
});
check('owner identity', async () => {
  const r = await call('GET', '/api/me', OWNER);
  assert.equal(r.body.operator.role, 'r_owner');
});
check('evaluate uses site time zone', async () => {
  const r = await call('POST', '/api/evaluate', OWNER, { userId: 'u1', lockId: 9001, localTime: '2026-07-01T08:30' });
  assert.equal(r.body.timeZone, 'Europe/London');
  assert.equal(r.body.result.allowed, true);
});
check('passcode requires a permitted person', async () => {
  assert.equal((await call('POST', '/api/passcode', OWNER, { lockId: 9002 })).status, 400);
  assert.equal((await call('POST', '/api/passcode', OWNER, { lockId: 9001, userId: 'u5' })).status, 403);
  assert.equal((await call('POST', '/api/passcode', OWNER, { lockId: 9001, userId: 'u1' })).status, 409);
  const r = await call('POST', '/api/passcode', OWNER, { lockId: 9002, userId: 'u2' });
  assert.equal(r.status, 200);
  assert.equal(r.body.credential.enforcement, 'lock');
});
check('gym manager cannot issue office passcodes', async () => {
  assert.equal((await call('POST', '/api/passcode', GYM, { lockId: 9002, userId: 'u2' })).status, 403);
});
check('credential registry and revoke', async () => {
  const list = await call('GET', '/api/credentials', OWNER);
  assert.ok(list.body.credentials.length >= 1);
  const active = list.body.credentials.find(c => c.status === 'active');
  const r = await call('DELETE', `/api/credentials/${active.id}`, OWNER);
  assert.equal(r.body.credential.status, 'revoked');
});
check('suspending a user auto-revokes their credentials', async () => {
  const issued = await call('POST', '/api/passcode', OWNER, { lockId: 9002, userId: 'u2' });
  assert.equal(issued.status, 200);
  const r = await call('POST', '/api/users/u2/suspend', OWNER);
  assert.equal(r.status, 200);
  assert.ok(r.body.reconcile.revoked >= 1, JSON.stringify(r.body.reconcile));
  const creds = await call('GET', '/api/credentials', OWNER);
  const c = creds.body.credentials.find(x => x.id === issued.body.credential.id);
  assert.equal(c.status, 'revoked');
  assert.equal(c.revokedBy, 'system:reconciler');
  assert.equal((await call('POST', '/api/users/u2/unsuspend', OWNER)).status, 200);
});
check('audit entries for people carry ids, never names or emails', async () => {
  const created = await call('POST', '/api/users', OWNER, { name: 'Zed Private', email: 'zed@private.example', groupIds: ['ug_staff'] });
  const log = await call('GET', '/api/audit?limit=5&action=users.create', OWNER);
  const entry = log.body.log.find(e => e.detail.startsWith(created.body.item.id));
  assert.ok(entry);
  assert.doesNotMatch(entry.detail, /Zed|zed@/);
  assert.equal((await call('DELETE', `/api/users/${created.body.item.id}`, OWNER)).status, 200);
});
check('platform creates an isolated tenant', async () => {
  if (!PLATFORM) return;
  assert.equal((await call('POST', '/api/tenants', OWNER, { name: 'x' })).status, 401);
  const t = await call('POST', '/api/tenants', PLATFORM, { name: 'Smoke Co' });
  assert.equal(t.status, 200);
  const token = t.body.owner.token;
  assert.deepEqual((await call('GET', '/api/users', token)).body.users, []);
  assert.deepEqual((await call('GET', '/api/doors', token)).body.doors, []);
  assert.equal((await call('DELETE', '/api/users/u1', token)).status, 404);
  assert.equal((await call('POST', '/api/doors/9001/unlock', token, { reason: 'try' })).status, 404);
  assert.equal((await call('POST', '/api/passcode', token, { lockId: 9001, userId: 'u1' })).status, 404);
  assert.equal((await call('GET', '/api/records/9001', token)).status, 404);
  const audit = await call('GET', '/api/audit', token);
  assert.ok(audit.body.log.every(e => e.seq <= 3));
  assert.equal((await call('GET', '/api/audit/verify', token)).body.verification.ok, true);
  assert.equal((await call('GET', '/api/tenants', token)).status, 401);
});
check('cron reconcile runs', async () => {
  const res = await fetch(`${BASE}/cdn-cgi/local/scheduled`);
  assert.equal(res.status, 200);
});
check('audit chain verifies and records operators', async () => {
  const v = await call('GET', '/api/audit/verify', OWNER);
  assert.equal(v.body.verification.ok, true, JSON.stringify(v.body.verification));
  assert.ok(v.body.verification.count > 5);
  const log = await call('GET', '/api/audit?limit=5', OWNER);
  assert.equal(log.body.log.length, 5);
  assert.ok(log.body.log[0].seq > log.body.log[1].seq);
  assert.ok(log.body.log.some(e => e.actor === 'owner'));
});
check('validation rejects malformed records', async () => {
  const r = await call('POST', '/api/schedules', OWNER, { name: 'Broken', windows: [{ from: '09:00' }] });
  assert.equal(r.status, 400);
  assert.equal((await call('DELETE', '/api/schedules/sch_office', OWNER)).status, 409);
});
check('copilot output escapes stored names', async () => {
  await call('POST', '/api/users', OWNER, { name: '<img src=x onerror=alert(1)>', groupIds: ['ug_it'], suspended: true });
  const r = await call('POST', '/api/ai', OWNER, { q: 'anything unusual?' });
  assert.equal(r.body.answer.includes('<img src=x'), false);
});
check('static assets carry a strict CSP', async () => {
  const res = await fetch(BASE + '/');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self';/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
check('policy compiler reports enforcement levels', async () => {
  const r = await call('GET', '/api/compile', OWNER);
  assert.equal(r.status, 200);
  assert.equal(r.body.summary.rules, 9);
  assert.ok(r.body.summary.cloud >= 1 && r.body.summary.lock >= 1);
  const gym = await call('GET', '/api/compile', GYM);
  assert.ok(gym.body.locks.every(l => [9101, 9102].includes(l.lockId)));
});
check('wrong token is rejected', async () => {
  assert.equal((await call('GET', '/api/me', 'nope')).status, 401);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log(`ok   ${name}`); } catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message}`); }
  }
  console.log(`${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
