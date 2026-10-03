const test = require('node:test');
const assert = require('node:assert/strict');
const { revocationReport, percentile } = require('../reports-core');
const { boot } = require('../support/boot');

const T0 = Date.parse('2026-09-01T09:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const ev = (s, action, detail) => ({ ts: at(s), action, detail });

test('percentile uses nearest rank', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([], 50), null);
});

test('revocation report: remote, on-site, open and still-active items', () => {
  const events = [
    ev(0, 'users.suspend', 'u1'),
    ev(4, 'credential.auto_revoke', 'c1 lock 9001 user u1: user suspended'),
    ev(5, 'credential.pending_removal', 'c2 lock 9004 user u1: no gateway, on-site removal required'),
    ev(3 * 3600, 'credential.removed_on_site', 'c2 lock 9004 user u1'),
    ev(100, 'scim.user_deactivate', 'usr_x'),
    ev(102, 'credential.auto_revoke', 'c3 lock 9002 user usr_x: user suspended'),
    ev(103, 'credential.pending_removal', 'c4 lock 9004 user usr_x: no gateway'),
    ev(200, 'users.delete', 'u9 (personal data erased)'),
    // noise: revokes without a trigger, other actions
    ev(300, 'credential.auto_revoke', 'c9 lock 9001 user u7: expired'),
    ev(301, 'unlock.granted', 'lock 9001 user u1'),
  ];
  const credentials = [{ id: 'c5', userId: 'u9', lockId: 9003, status: 'active', issuedAt: at(-86400) }];
  const r = revocationReport(events, { credentials, now: T0 + 86400e3, since: T0 - 1000 });
  assert.equal(r.triggers, 3);
  assert.deepEqual(r.remote, { count: 2, p50Sec: 2, p95Sec: 4, maxSec: 4 });
  assert.deepEqual(r.onsite, { count: 1, p50Sec: 3 * 3600, p95Sec: 3 * 3600, maxSec: 3 * 3600 });
  assert.equal(r.open.count, 2);
  assert.equal(r.open.stillActive, 1);
  assert.equal(r.open.items[0].outcome, 'open_remote', 'still-working codes are listed first');
  assert.equal(r.open.items[0].credentialId, 'c5');
  assert.equal(r.open.items[1].credentialId, 'c4');
  assert.equal(r.open.oldestSec, 86400 - 100);
  assert.ok(!r.items.some(i => i.credentialId === 'c9'), 'revocations without a trigger are not counted');
  // Site scope: only locks the operator can see.
  const scoped = revocationReport(events, { credentials, now: T0 + 86400e3, since: T0 - 1000, lockVisible: id => id === 9001 });
  assert.equal(scoped.credentials, 1);
  assert.equal(scoped.open.count, 0);
  // Window: triggers before `since` are ignored.
  assert.equal(revocationReport(events, { since: T0 + 150 * 1000, now: T0 + 86400e3 }).triggers, 1);
});

test('GET /api/reports/revocation measures a real suspend end to end', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', AUTH_OPEN_READS: '0' });
  t.after(api.close);
  const owner = { token: 'owner-token' };
  const online = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9003, userId: 'u3', acknowledgeScheduleGap: true } });
  const offline = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9004, userId: 'u3', acknowledgeScheduleGap: true } });
  assert.equal(online.status, 200);
  assert.equal(offline.status, 200);
  await api.call('POST', '/api/users/u3/suspend', owner);
  let r = (await api.call('GET', '/api/reports/revocation?days=7', owner)).body;
  assert.equal(r.windowDays, 7);
  assert.equal(r.triggers, 1);
  assert.equal(r.remote.count, 1);
  assert.ok(r.remote.maxSec <= 5, `remote revoke took ${r.remote.maxSec}s`);
  assert.equal(r.open.count, 1);
  assert.equal(r.open.items[0].lockId, 9004);
  await api.call('POST', `/api/credentials/${offline.body.credential.id}/confirm-removed`, owner);
  r = (await api.call('GET', '/api/reports/revocation', owner)).body;
  assert.equal(r.open.count, 0);
  assert.equal(r.onsite.count, 1);
  // Needs report.read.
  assert.equal((await api.call('GET', '/api/reports/revocation')).status, 401);
});
