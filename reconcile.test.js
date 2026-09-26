const assert = require('node:assert/strict');
const test = require('node:test');
const reconciler = require('./reconcile-core');

const HOUR = 36e5;
const now = Date.parse('2026-09-27T02:00:00Z');
function snapshot(overrides = {}) {
  return {
    sites: [{ id: 's1', name: 'Sydney office', timezone: 'Australia/Sydney' }],
    doorGroups: [{ id: 'dg', siteId: 's1', name: 'Doors', lockIds: [1, 2] }],
    userGroups: [{ id: 'g', name: 'Staff', siteId: 's1' }],
    schedules: [{ id: 'all', name: '24/7', windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '23:59' }] }],
    assignments: [{ id: 'a', userGroupId: 'g', doorGroupId: 'dg', scheduleId: 'all' }],
    holidays: [],
    users: [{ id: 'u1', name: 'A', groupIds: ['g'], suspended: false }, { id: 'u2', name: 'B', groupIds: ['g'], suspended: true }],
    credentials: [
      { id: 'c_ok', type: 'passcode', userId: 'u1', lockId: 1, status: 'active', endAt: new Date(now + 24 * HOUR).toISOString(), vendorRef: '11' },
      { id: 'c_susp_online', type: 'passcode', userId: 'u2', lockId: 1, status: 'active', endAt: new Date(now + 24 * HOUR).toISOString(), vendorRef: '12' },
      { id: 'c_susp_offline', type: 'passcode', userId: 'u2', lockId: 2, status: 'active', endAt: new Date(now + 24 * HOUR).toISOString(), vendorRef: '13' },
      { id: 'c_expired', type: 'passcode', userId: 'u1', lockId: 2, status: 'active', endAt: new Date(now - HOUR).toISOString(), vendorRef: '14' },
    ],
    ...overrides,
  };
}
const locks = [{ lockId: 1, hasGateway: 1 }, { lockId: 2, hasGateway: 0 }];

function fakeUow() {
  const calls = { update: [], audit: [] };
  return { calls, update(c, id, patch) { calls.update.push({ id, ...patch }); return this; }, audit(action, detail, actor) { calls.audit.push({ action, detail, actor }); return this; } };
}

test('plan: online → revoke, offline → pending removal, expiry → expire; valid codes untouched', () => {
  const p = reconciler.plan(snapshot(), locks, { now });
  const byId = Object.fromEntries(p.actions.map(a => [a.credentialId, a]));
  assert.equal(byId.c_ok, undefined);
  assert.equal(byId.c_susp_online.type, 'revoke');
  assert.equal(byId.c_susp_offline.type, 'pending_removal');
  assert.equal(byId.c_expired.type, 'expire');
  assert.equal(byId.c_expired.remote, false); // offline lock: it refuses the expired code by itself
});

test('plan: DST notice for Sydney one week before the change (4 Oct 2026)', () => {
  const p = reconciler.plan(snapshot(), locks, { now });
  assert.equal(p.notices.length, 1);
  assert.equal(p.notices[0].date, '2026-10-04');
  assert.equal(p.notices[0].shiftMinutes, 60);
  assert.deepEqual(p.notices[0].offlineLocks, [2]);
});

test('execute: vendor delete, status + audit per credential, actor is the reconciler', async () => {
  const deleted = [];
  const vendor = { deletePasscode: async (lockId, ref) => deleted.push([lockId, ref]) };
  const snap = snapshot();
  const uow = fakeUow();
  const out = await reconciler.execute(reconciler.plan(snap, locks, { now }), { vendor, uow, snapshot: snap, now });
  assert.deepEqual(deleted, [[1, '12']]); // only the online lock is touched remotely
  assert.deepEqual(out.summary, { revoked: 1, expired: 1, pendingRemoval: 1, failed: 0 });
  assert.ok(uow.calls.audit.every(a => a.actor === 'system:reconciler'));
  assert.deepEqual(uow.calls.audit.map(a => a.action).sort(), ['credential.auto_revoke', 'credential.expire', 'credential.pending_removal']);
});

test('execute: a vendor failure keeps the credential active and is retried next run', async () => {
  const vendor = { deletePasscode: async () => { throw new Error('gateway timeout'); } };
  const snap = snapshot();
  const uow = fakeUow();
  const out = await reconciler.execute(reconciler.plan(snap, locks, { now }), { vendor, uow, snapshot: snap, now });
  assert.equal(out.summary.failed, 1);
  assert.equal(uow.calls.update.some(u => u.id === 'c_susp_online'), false);
  assert.ok(uow.calls.audit.some(a => a.action === 'credential.revoke_failed' && /gateway timeout/.test(a.detail)));
  // Next run: still active → planned again.
  assert.ok(reconciler.plan(snap, locks, { now }).actions.some(a => a.credentialId === 'c_susp_online'));
});

test('plan: a pending removal is finished remotely once the lock gains a gateway', () => {
  const snap = snapshot({ credentials: [{ id: 'c_p', type: 'passcode', userId: 'u2', lockId: 2, status: 'pending_removal', vendorRef: '9' }] });
  assert.deepEqual(reconciler.plan(snap, locks, { now }).actions, []);
  const p = reconciler.plan(snap, [{ lockId: 2, hasGateway: 1 }], { now });
  assert.equal(p.actions[0].type, 'revoke');
});

test('plan: can be limited to one user or to the locks an operator may see', () => {
  assert.ok(reconciler.plan(snapshot(), locks, { now, userId: 'u1' }).actions.every(a => a.userId === 'u1'));
  assert.ok(reconciler.plan(snapshot(), locks, { now, lockFilter: id => id === 1 }).actions.every(a => a.lockId === 1));
});
