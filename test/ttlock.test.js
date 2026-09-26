const test = require('node:test');
const assert = require('node:assert/strict');
const { TTLock, TTLockError } = require('../ttlock');
const { deletePasscodeIdempotent } = require('../vendor-ttlock');
const reconciler = require('../reconcile-core');

function fakeCloud(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const params = Object.fromEntries(init.body ? new URLSearchParams(String(init.body)) : u.searchParams);
    calls.push({ path: u.pathname, params });
    const body = u.pathname === '/oauth2/token' ? { access_token: 'tok', expires_in: 3600 } : handler(u.pathname, params);
    return { json: async () => body }; // TTLock: HTTP 200 even for errors
  };
  const tt = new TTLock({ clientId: 'c', clientSecret: 's', username: 'u', password: 'p', fetch });
  return { tt, calls };
}

test('deletePasscode sends deleteType=2 (gateway), not the Bluetooth default', async () => {
  const { tt, calls } = fakeCloud(() => ({ errcode: 0 }));
  await tt.deletePasscode(9001, 555);
  const del = calls.find(c => c.path === '/v3/keyboardPwd/delete');
  assert.equal(del.params.deleteType, '2');
  assert.equal(del.params.keyboardPwdId, '555');
});

test('errcode in a 200 response becomes a TTLockError with the code', async () => {
  const { tt } = fakeCloud(() => ({ errcode: -2012, errmsg: 'lock not connected to any gateway' }));
  await assert.rejects(tt.deletePasscode(9001, 1), e => e instanceof TTLockError && e.errcode === -2012);
});

test('idempotent delete: no gateway, already gone, still present, cannot verify', async () => {
  let listed = [];
  let deleteError = { errcode: -2012, errmsg: 'no gateway' };
  const { tt } = fakeCloud(path => {
    if (path === '/v3/keyboardPwd/delete') return deleteError;
    if (path === '/v3/lock/listKeyboardPwd') return Array.isArray(listed) ? { list: listed, pages: 1 } : listed;
    return {};
  });
  await assert.rejects(deletePasscodeIdempotent(tt, 9001, 42), e => e.code === 'NO_GATEWAY');

  deleteError = { errcode: 1, errmsg: 'failed' }; // e.g. a retry after a lost response
  listed = [{ keyboardPwdId: 7 }];
  assert.deepEqual(await deletePasscodeIdempotent(tt, 9001, 42), { deleted: true, alreadyGone: true });

  listed = [{ keyboardPwdId: 42 }];
  await assert.rejects(deletePasscodeIdempotent(tt, 9001, 42), e => e.errcode === 1, 'still on the lock → real failure');

  listed = { errcode: 30006, errmsg: 'call limit exceeded' };
  await assert.rejects(deletePasscodeIdempotent(tt, 9001, 42), e => e.errcode === 1, 'cannot verify → keep the original failure');

  deleteError = { errcode: 0 };
  assert.deepEqual(await deletePasscodeIdempotent(tt, 9001, 42), { deleted: true });
});

test('reconciler: a gateway that turns out unreachable → pending_removal, not a failure loop', async () => {
  const snapshot = { credentials: [{ id: 'c1', type: 'passcode', vendorRef: '42', lockId: 9001, userId: 'u1', status: 'active' }] };
  const planned = { actions: [{ credentialId: 'c1', userId: 'u1', lockId: 9001, reasons: ['user suspended'], type: 'revoke', remote: true }] };
  const writes = [];
  const audits = [];
  const uow = { update: (...a) => writes.push(a), audit: (...a) => audits.push(a) };
  const vendor = { deletePasscode: async () => { const e = new Error('lock 9001 is not connected to a gateway (-2012)'); e.code = 'NO_GATEWAY'; throw e; } };
  const out = await reconciler.execute(planned, { vendor, uow, snapshot });
  assert.deepEqual(out.summary, { revoked: 0, expired: 0, pendingRemoval: 1, failed: 0 });
  assert.equal(writes[0][2].status, 'pending_removal');
  assert.equal(audits[0][0], 'credential.pending_removal');
  assert.match(audits[0][1], /^c1 lock 9001 user u1: user suspended; .*-2012.*on-site removal required$/);

  // Already pending and still unreachable → no new write, no duplicate audit.
  const again = await reconciler.execute(planned, { vendor, uow: { update: () => assert.fail(), audit: () => assert.fail() }, snapshot: { credentials: [{ ...snapshot.credentials[0], status: 'pending_removal' }] } });
  assert.equal(again.summary.pendingRemoval, 0);
  assert.equal(again.summary.failed, 0);

  // Already gone → revoked, noted in the audit.
  const gone = { deletePasscode: async () => ({ deleted: true, alreadyGone: true }) };
  const a2 = [];
  await reconciler.execute(planned, { vendor: gone, uow: { update: () => {}, audit: (...a) => a2.push(a) }, snapshot });
  assert.equal(a2[0][0], 'credential.auto_revoke');
  assert.match(a2[0][1], /already gone from the lock/);
});
