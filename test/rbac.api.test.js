const assert = require('node:assert/strict');
const test = require('node:test');
const { boot } = require('../support/boot');
const { sha256 } = require('../auth');

const OPERATORS = JSON.stringify([
  { id: 'op_gym', name: 'Gym manager', role: 'r_manager', siteIds: ['site_gym'], tokenSha256: sha256('gym-token') },
  { id: 'op_audit', name: 'Auditor', role: 'r_view', tokenSha256: sha256('audit-token') },
]);

test('site managers only see and unlock doors at their own sites', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS });
  t.after(api.close);

  const doors = await api.call('GET', '/api/doors', { token: 'gym-token' });
  assert.equal(doors.status, 200);
  assert.deepEqual(doors.body.doors.map(d => d.lockId).sort(), [9101, 9102]);

  const own = await api.call('POST', '/api/doors/9101/unlock', { token: 'gym-token', body: {} });
  assert.equal(own.status, 200);
  const other = await api.call('POST', '/api/doors/9002/unlock', { token: 'gym-token', body: {} });
  assert.equal(other.status, 403);

  const rules = await api.call('POST', '/api/schedules', { token: 'gym-token', body: { name: 'x' } });
  assert.equal(rules.status, 403);
  assert.equal(rules.body.required, 'rule.manage');
});

test('auditors can read the audit trail but cannot unlock', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS });
  t.after(api.close);
  assert.equal((await api.call('GET', '/api/audit', { token: 'audit-token' })).status, 200);
  assert.equal((await api.call('POST', '/api/doors/9001/unlock', { token: 'audit-token', body: {} })).status, 403);
  const me = await api.call('GET', '/api/me', { token: 'audit-token' });
  assert.equal(me.body.operator.roleName, 'Auditor');
});

test('audit entries record which operator acted', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS });
  t.after(api.close);
  await api.call('POST', '/api/doors/9101/unlock', { token: 'gym-token', body: {} });
  const log = await api.call('GET', '/api/audit', { token: 'owner-token' });
  assert.equal(log.body.log[0].actor, 'op_gym');
});

test('server generates ids; clients cannot choose or overwrite them', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const res = await api.call('POST', '/api/holidays', { token: 'owner-token', body: { id: 'site_river', date: '2026-12-25' } });
  assert.notEqual(res.body.item.id, 'site_river');
});
