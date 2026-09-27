const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');

const OWNER = { token: 'owner-token' };
const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
const M1 = { token: 'm1-token' };
const M2 = { token: 'm2-token' };
const AUD = { token: 'aud-token' };
const OPERATORS = JSON.stringify([
  { id: 'op_m1', name: 'Manager One', role: 'r_manager', tokenSha256: sha256Hex('m1-token') },
  { id: 'op_m2', name: 'Manager Two', role: 'r_manager', tokenSha256: sha256Hex('m2-token') },
  { id: 'op_aud', name: 'Auditor', role: 'r_view', tokenSha256: sha256Hex('aud-token') },
]);

async function setup(t, env = {}) {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, RECONCILE_INTERVAL_MIN: '0', SECRETS_KEY, ...env });
  t.after(api.close);
  const dg = await api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Server room', siteId: 'site_river', lockIds: [9002], sensitive: true } });
  assert.equal(dg.status, 200, JSON.stringify(dg.body));
  assert.equal(dg.body.item.sensitive, true);
  return { api, dg: dg.body.item };
}
const creds = async api => (await api.call('GET', '/api/credentials', OWNER)).body.credentials.filter(c => c.status === 'active');

test('passcode on a sensitive door: 202 → a different operator with the same permission approves → issued as the requester', async t => {
  const { api } = await setup(t);
  const before = (await creds(api)).length;
  const req = await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9002, userId: 'u2' } });
  assert.equal(req.status, 202, JSON.stringify(req.body));
  assert.equal(req.body.approvalRequired, true);
  assert.deepEqual(req.body.approval.locks, [9002]);
  assert.equal(req.body.passcode, undefined, 'no code yet');
  assert.equal((await creds(api)).length, before, 'nothing on the lock yet');
  const id = req.body.approval.id;

  const self = await api.call('POST', `/api/approvals/${id}/approve`, { ...M1, body: {} });
  assert.equal(self.status, 403);
  assert.match(self.body.detail, /four-eyes/);
  const aud = await api.call('POST', `/api/approvals/${id}/approve`, { ...AUD, body: {} });
  assert.equal(aud.status, 403);
  assert.match(aud.body.detail, /credential\.issue/);

  const list2 = (await api.call('GET', '/api/approvals', M2)).body.approvals;
  assert.equal(list2.find(a => a.id === id).canDecide, true);
  assert.equal((await api.call('GET', '/api/approvals', M1)).body.approvals.find(a => a.id === id).canCancel, true);

  const ok = await api.call('POST', `/api/approvals/${id}/approve`, { ...M2, body: { note: 'ticket CHG-1042' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.result.passcode, undefined, 'the approver never sees the code');
  assert.ok(!JSON.stringify(ok.body).match(/keyboardPwd|codeHint/), 'not even a hint');
  assert.equal(ok.body.result.codeHeldFor, 'op_m1');
  assert.equal(ok.body.result.credential.issuedBy, 'op_m1', 'issued in the requester\'s name');
  // Only the requester can collect it, once.
  assert.equal((await api.call('POST', `/api/approvals/${id}/collect`, { ...M2, body: {} })).status, 404, 'the approver cannot collect');
  assert.equal((await api.call('POST', `/api/approvals/${id}/collect`, { ...OWNER, body: {} })).status, 404, 'nor can the owner');
  const ready = (await api.call('GET', '/api/approvals', M1)).body.ready;
  assert.deepEqual(ready.map(a => a.id), [id]);
  assert.equal((await api.call('GET', '/api/approvals', M2)).body.ready.length, 0);
  const got = await api.call('POST', `/api/approvals/${id}/collect`, { ...M1, body: {} });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.match(String(got.body.passcode.keyboardPwd), /^\d{4,9}$/);
  assert.equal(got.body.credential.id, ok.body.result.credential.id);
  const again = await api.call('POST', `/api/approvals/${id}/collect`, { ...M1, body: {} });
  assert.equal(again.status, 410);
  assert.match(again.body.error, /already collected/);
  const row = await api.server.store.sql.first('SELECT sealed_code, collected_at FROM approvals WHERE id = ?', [id]);
  assert.equal(row.sealed_code, null, 'nothing left in the database');
  assert.ok(row.collected_at);
  assert.equal((await creds(api)).length, before + 1);
  const log = (await api.call('GET', '/api/audit?limit=10', OWNER)).body.log;
  assert.match(log.find(e => e.action === 'passcode.create').detail, new RegExp(`approval=${id} approvedBy=op_m2`));
  assert.match(log.find(e => e.action === 'approval.approve').detail, /ticket CHG-1042/);
  assert.equal(log.find(e => e.action === 'approval.collect').actor, 'op_m1');
  assert.equal((await api.call('POST', `/api/approvals/${id}/approve`, { ...OWNER, body: {} })).status, 409, 'already approved');
  const done = (await api.call('GET', '/api/approvals?status=all', OWNER)).body.approvals.find(a => a.id === id);
  assert.equal(done.status, 'approved');
  assert.equal(done.decidedBy, 'op_m2');
  assert.equal(done.result.ok, true);

  // Non-sensitive doors are unaffected.
  assert.equal((await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9001, userId: 'u1', acknowledgeScheduleGap: true } })).status, 200);
});

test('approval re-validates: a person suspended in the meantime gets nothing; racing approvers → exactly one wins', async t => {
  const { api } = await setup(t, { WRITE_QUEUE: 'off' }); // exercise the in-transaction guard, not the queue
  const id = (await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9002, userId: 'u2' } })).body.approval.id;
  await api.call('POST', '/api/users/u2/suspend', OWNER);
  const late = await api.call('POST', `/api/approvals/${id}/approve`, { ...M2, body: {} });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /approved, but the change could not be applied/);
  assert.equal((await api.call('GET', '/api/approvals?status=failed', OWNER)).body.approvals[0].id, id);
  assert.equal((await creds(api)).filter(c => c.lockId === 9002 && c.userId === 'u2').length, 0);
  // Reinstating u2 reaches the sensitive door again: that too needs a second person.
  const back = await api.call('POST', '/api/users/u2/unsuspend', OWNER);
  assert.equal(back.status, 202);
  assert.equal((await api.call('POST', `/api/approvals/${back.body.approval.id}/approve`, { ...M2, body: {} })).status, 200);

  const id2 = (await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9002, userId: 'u2' } })).body.approval.id;
  // Force the interleaving: both deciders read "pending" before either commits.
  const sql = api.server.store.sql;
  const first = sql.first.bind(sql);
  sql.first = async (q, p) => {
    const row = await first(q, p);
    if (/FROM approvals WHERE tenant_id = \? AND id = \?/.test(q)) await new Promise(r => setTimeout(r, 60));
    return row;
  };
  t.after(() => { sql.first = first; });
  const [a, b] = await Promise.all([
    api.call('POST', `/api/approvals/${id2}/approve`, { ...M2, body: {} }),
    api.call('POST', `/api/approvals/${id2}/approve`, { ...OWNER, body: {} }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.status} ${b.status}`);
  assert.equal((await creds(api)).filter(c => c.lockId === 9002 && c.userId === 'u2').length, 1, 'one code, not two');
});

test('assignments, alias door groups, new members and deleting the protection all need a second person; removal does not', async t => {
  const { api, dg } = await setup(t);
  const owner2 = { token: (await api.call('POST', '/api/operators', { ...OWNER, body: { name: 'Second owner', role: 'r_owner' } })).body.token };

  // An unflagged group around the same lock would be a bypass.
  const alias = await api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Alias', siteId: 'site_river', lockIds: [9002] } });
  assert.equal(alias.status, 202);

  const asg = await api.call('POST', '/api/assignments', { ...OWNER, body: { userGroupId: 'ug_staff', doorGroupId: dg.id } });
  assert.equal(asg.status, 202);
  const ok = await api.call('POST', `/api/approvals/${asg.body.approval.id}/approve`, { ...owner2, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const assignmentId = ok.body.result.item.id;

  // ug_staff now reaches the server room: a new member needs approval too — rejected here.
  const person = await api.call('POST', '/api/users', { ...OWNER, body: { name: 'New Starter', groupIds: ['ug_staff'] } });
  assert.equal(person.status, 202);
  const rej = await api.call('POST', `/api/approvals/${person.body.approval.id}/reject`, { ...owner2, body: { note: 'no ticket' } });
  assert.equal(rej.body.approval.status, 'rejected');
  assert.equal((await api.call('GET', '/api/users', OWNER)).body.users.some(u => u.name === 'New Starter'), false);

  // Removing access never waits.
  assert.equal((await api.call('DELETE', `/api/assignments/${assignmentId}`, OWNER)).status, 200);

  // Deleting a sensitive group removes the protection: request, then the requester cancels.
  const del = await api.call('DELETE', `/api/doorGroups/${dg.id}`, OWNER);
  assert.equal(del.status, 202);
  assert.equal((await api.call('POST', `/api/approvals/${del.body.approval.id}/cancel`, { ...owner2, body: {} })).status, 403, 'only the requester cancels');
  assert.equal((await api.call('POST', `/api/approvals/${del.body.approval.id}/cancel`, { ...OWNER, body: {} })).body.approval.status, 'cancelled');

  // Expiry after 72 h.
  const stale = (await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9002, userId: 'u2' } })).body.approval.id;
  await api.server.store.sql.batch([{ sql: 'UPDATE approvals SET expires_at = ? WHERE id = ?', params: ['2000-01-01T00:00:00.000Z', stale] }]);
  assert.equal((await api.call('POST', `/api/approvals/${stale}/approve`, { ...owner2, body: {} })).status, 409);
  assert.equal((await api.call('GET', '/api/approvals?status=expired', OWNER)).body.approvals[0].id, stale);
  const actions = (await api.call('GET', '/api/audit?limit=60', OWNER)).body.log.map(e => e.action);
  for (const a of ['approval.request', 'approval.approve', 'approval.reject', 'approval.cancel', 'approval.expire']) assert.ok(actions.includes(a), a);
});

test('four-eyes passcodes fail closed without SECRETS_KEY; uncollected codes are discarded after 72 h', async t => {
  const { api } = await setup(t, { SECRETS_KEY: '' });
  const r = await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9002, userId: 'u2' } });
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'secrets_key_missing');
  assert.equal((await api.call('GET', '/api/approvals', M2)).body.approvals.length, 0, 'no request created');
  assert.equal((await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9001, userId: 'u1', acknowledgeScheduleGap: true } })).status, 200, 'other doors unaffected');
});

test('an approved code nobody collects is thrown away after 72 h (audited)', async t => {
  const { api } = await setup(t);
  const id = (await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9002, userId: 'u2' } })).body.approval.id;
  assert.equal((await api.call('POST', `/api/approvals/${id}/approve`, { ...M2, body: {} })).status, 200);
  await api.server.store.sql.batch([{ sql: 'UPDATE approvals SET decided_at = ? WHERE id = ?', params: [new Date(Date.now() - 73 * 36e5).toISOString(), id] }]);
  const late = await api.call('POST', `/api/approvals/${id}/collect`, { ...M1, body: {} });
  assert.equal(late.status, 410);
  assert.match(late.body.error, /no code is waiting/);
  const log = (await api.call('GET', '/api/audit?action=approval.code_discarded', OWNER)).body.log;
  assert.equal(log.length, 1);
  assert.match(log[0].detail, new RegExp(`^${id}: not collected`));
});

test('reinstating a suspended person who reaches a sensitive door needs a second person (closes the create-suspended-then-unsuspend bypass)', async t => {
  const { api } = await setup(t);
  const user = async id => (await api.call('GET', '/api/users', OWNER)).body.users.find(u => u.id === id);

  // u2 (ug_it) reaches the sensitive server room (9002).
  assert.equal((await api.call('POST', '/api/users/u2/suspend', M1)).status, 200, 'removing access never waits');
  const req = await api.call('POST', '/api/users/u2/unsuspend', { ...M1, body: {} });
  assert.equal(req.status, 202, JSON.stringify(req.body));
  assert.deepEqual(req.body.approval.locks, [9002]);
  assert.equal((await user('u2')).suspended, true, 'still suspended until approved');
  assert.equal((await api.call('POST', `/api/approvals/${req.body.approval.id}/approve`, { ...M1, body: {} })).status, 403, 'not by the requester');
  const ok = await api.call('POST', `/api/approvals/${req.body.approval.id}/approve`, { ...M2, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await user('u2')).suspended, false);
  const log = (await api.call('GET', '/api/audit?action=users.unsuspend', OWNER)).body.log;
  assert.equal(log.length, 1);
  assert.equal(log[0].actor, 'op_m1', 'recorded in the requester\'s name');
  assert.equal((await api.call('POST', '/api/users/u2/unsuspend', { ...M1, body: {} })).status, 200, 'already active: nothing to approve');

  // The bypass: create in a sensitive group as suspended (no approval), then unsuspend.
  const created = await api.call('POST', '/api/users', { ...M1, body: { name: 'Side Door', groupIds: ['ug_it'], suspended: true } });
  assert.equal(created.status, 200, 'a suspended person grants nothing yet');
  const sneak = await api.call('POST', `/api/users/${created.body.item.id}/unsuspend`, { ...M1, body: {} });
  assert.equal(sneak.status, 202, 'the unsuspend is where the access starts, so it is gated');

  // No sensitive door in reach → no approval; already active → nothing to approve.
  assert.equal((await api.call('POST', '/api/users/u5/unsuspend', { ...M1, body: {} })).status, 200, 'u5 (ug_staff) reaches no sensitive door');
  assert.equal((await api.call('POST', '/api/users/u1/unsuspend', { ...M1, body: {} })).status, 200);
});

test('deleting a future holiday that closes a sensitive door needs a second person; past or other-site holidays do not', async t => {
  const api = await boot({
    ADMIN_TOKEN: 'owner-token', RECONCILE_INTERVAL_MIN: '0', SECRETS_KEY,
    OPERATORS: JSON.stringify([{ id: 'op_o2', name: 'Owner Two', role: 'r_owner', tokenSha256: sha256Hex('o2-token') }]),
  });
  t.after(api.close);
  const O2 = { token: 'o2-token' };
  // 9003 is reached by ug_staff on sch_office, which is closed on holidays.
  assert.equal((await api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Pharmacy store', siteId: 'site_river', lockIds: [9003], sensitive: true } })).status, 200);
  // 9002 is sensitive too, but only reached on sch_24, which ignores holidays: not re-opened.
  assert.equal((await api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Server room', siteId: 'site_river', lockIds: [9002], sensitive: true } })).status, 200);
  const next = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const add = async body => (await api.call('POST', '/api/holidays', { ...OWNER, body })).body.item;
  const riverXmas = await add({ date: next, name: 'Site shutdown', siteId: 'site_river' });
  const everywhere = await add({ date: next, name: 'Public holiday' });
  const gymOnly = await add({ date: next, name: 'Gym refit', siteId: 'site_gym' });
  const past = (await api.call('GET', '/api/holidays', OWNER)).body.holidays.find(h => h.date === '2026-08-23');
  assert.ok(past, 'seeded past holiday');

  // Adding a closure never waits; removing one that re-opens a sensitive door does.
  const req = await api.call('DELETE', `/api/holidays/${riverXmas.id}`, OWNER);
  assert.equal(req.status, 202, JSON.stringify(req.body));
  assert.deepEqual(req.body.approval.locks, [9003]);
  assert.match(req.body.approval.summary, /delete holiday .*re-opens/);
  assert.ok((await api.call('GET', '/api/holidays', OWNER)).body.holidays.some(h => h.id === riverXmas.id), 'still there until approved');
  assert.equal((await api.call('DELETE', `/api/holidays/${everywhere.id}`, OWNER)).status, 202, 'a site-less holiday applies everywhere');

  assert.equal((await api.call('DELETE', `/api/holidays/${gymOnly.id}`, OWNER)).status, 200, 'the gym holiday closes no sensitive door');
  assert.equal((await api.call('DELETE', `/api/holidays/${past.id}`, OWNER)).status, 200, 'a past holiday re-opens nothing');

  const ok = await api.call('POST', `/api/approvals/${req.body.approval.id}/approve`, { ...O2, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(!(await api.call('GET', '/api/holidays', OWNER)).body.holidays.some(h => h.id === riverXmas.id));
});
