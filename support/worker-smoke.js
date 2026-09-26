#!/usr/bin/env node
// Smoke-test a running Worker (wrangler dev) with the same RBAC scenarios
// as the Express tests. Usage:
//   BASE=http://127.0.0.1:8787 OWNER=owner-token GYM=gym-token AUDIT=audit-token node support/worker-smoke.js
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
const { OWNER, GYM, AUDIT } = process.env;

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
  assert.equal((await call('POST', '/api/doors/9101/unlock', GYM, {})).status, 200);
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
