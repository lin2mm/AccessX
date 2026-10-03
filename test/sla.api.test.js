const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');

const OWNER = { token: 'owner-token' };

test('pending on-site removals: overdue after 48 h, escalated once in the audit, visible in the evidence pack', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  // 9004 has no gateway: suspending the person leaves the code on the lock.
  const issued = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9004, userId: 'u3', acknowledgeScheduleGap: true } });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const credId = issued.body.credential.id;
  await api.call('POST', '/api/users/u3/suspend', OWNER);
  const cred = (await api.call('GET', '/api/credentials', OWNER)).body.credentials.find(c => c.id === credId);
  assert.equal(cred.status, 'pending_removal');

  let r = await api.call('POST', '/api/reconcile', { ...OWNER, body: {} });
  assert.equal(r.body.summary.overdue, 0, 'fresh: within the SLA');

  // 49 hours later…
  await api.server.store.sql.batch([{ sql: 'UPDATE credentials SET revoked_at = ? WHERE id = ?', params: [new Date(Date.now() - 49 * 36e5).toISOString(), credId] }]);
  r = await api.call('POST', '/api/reconcile', { ...OWNER, body: {} });
  assert.equal(r.body.summary.overdue, 1);
  assert.equal(r.body.summary.escalated, 1);
  const notice = r.body.plan.notices.find(n => n.type === 'removal_overdue');
  assert.equal(notice.credentialId, credId);
  assert.equal(notice.ageHours, 49);
  r = await api.call('POST', '/api/reconcile', { ...OWNER, body: {} });
  assert.equal(r.body.summary.overdue, 1, 'still overdue');
  assert.equal(r.body.summary.escalated, 0, 'escalated only once');
  const log = (await api.call('GET', '/api/audit?action=credential.removal_overdue', OWNER)).body.log;
  assert.equal(log.length, 1);
  assert.match(log[0].detail, new RegExp(`^${credId} lock 9004 user u3 still on the lock after 49 h \\(SLA 48 h\\)`));

  const ev = (await api.call('GET', '/api/reports/evidence', OWNER)).body.evidence;
  assert.equal(ev.accessRemoval.pendingOnSite.find(p => p.credentialId === credId).ageHours, 49);
  assert.equal(ev.accessRemoval.overdueOnSite, 1);

  // Confirming the removal on site closes it.
  assert.equal((await api.call('POST', `/api/credentials/${credId}/confirm-removed`, { ...OWNER, body: {} })).status, 200);
  assert.equal((await api.call('POST', '/api/reconcile', { ...OWNER, body: {} })).body.summary.overdue, 0);
});
