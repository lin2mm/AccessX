/**
 * Nuki as the second lock vendor (R19): the Nuki client and adapter against a
 * fake Nuki Web API that is asynchronous like the real one, then the whole API
 * on a tenant connected to Nuki (connect, issue, revoke, sweep, token revoked).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { boot } = require('../support/boot');
const { nukiFixture } = require('../support/fake-nuki');
const { Nuki, codeOf, validKeypadCode } = require('../nuki');
const { createNukiVendor, newKeypadCode, mapPasscode } = require('../vendor-nuki-core');

const OWNER = { token: 'owner-token' };
const noSleep = async () => {};
const vendorOn = (cloud, token = 'nuki-river-token', opts = {}) => createNukiVendor(new Nuki({ token, apiBase: 'http://nuki.test', fetch: cloud.fetch }), { sleep: noSleep, pollTries: 4, ...opts });
const soon = h => new Date(Date.now() + h * 36e5).toISOString();

test('keypad codes follow Nuki\'s rules: 6 digits 1–9, never "12…", never one the keypad has', () => {
  for (let i = 0; i < 2000; i++) {
    const c = newKeypadCode(new Set());
    assert.ok(validKeypadCode(c) && !c.includes('0') && !c.startsWith('12') && c.length === 6, c);
  }
  // A generator that first proposes "12…" and a used code must skip both.
  const seq = [0, 1, 0, 0, 0, 0, /* 121111 */ 2, 2, 2, 2, 2, 2, /* 333333 used */ 3, 3, 3, 3, 3, 3 /* 444444 */];
  let i = 0;
  assert.equal(newKeypadCode(new Set(['333333']), () => seq[i++]), '444444');
  assert.equal(codeOf({ code: [252525] }), '252525');
  assert.equal(codeOf({ code: '252525' }), '252525');
  assert.equal(codeOf({ code: 252525 }), '252525');
  assert.equal(codeOf({}), null);
  const listed = mapPasscode({ id: 'x1', name: 'Old code', type: 13, code: [987654], allowedFromDate: '2026-01-01T00:00:00.000Z', allowedUntilDate: '2026-02-01T00:00:00.000Z', allowedWeekDays: 127 });
  assert.ok(!JSON.stringify(listed).includes('987654'), 'the digits never leave the adapter');
  assert.equal(listed.type, 'period');
  assert.equal(mapPasscode({ id: 'x2', name: 'Cleaner', type: 13, allowedWeekDays: 124, allowedFromTime: 360, allowedUntilTime: 480 }).type, 'cyclic');
  assert.equal(mapPasscode({ id: 'x3', name: 'Owner', type: 13 }).type, 'permanent');
});

test('Nuki adapter: fleet, asynchronous code creation, window with weekdays, delete, offline, no keypad, errors', async () => {
  const cloud = nukiFixture();
  let authFailures = 0;
  const v = vendorOn(cloud, 'nuki-river-token', { onAuthFailure: async () => { authFailures += 1; } });
  const locks = await v.listLocks();
  assert.deepEqual(locks.map(l => l.lockId), [9001, 9002, 9003, 9004]);
  const byId = Object.fromEntries(locks.map(l => [l.lockId, l]));
  assert.equal(byId[9004].hasGateway, 0, 'offline = like a door without a gateway');
  assert.equal(byId[9004].electricQuantity, 10, 'battery critical without a charge level');
  assert.equal(byId[9002].keypad, false);
  assert.equal(byId[9001].electricQuantity, 80);

  // Asynchronous: the code appears in the list only on the second look.
  const start = soon(1); const end = soon(5);
  const out = await v.createPasscode({ lockId: 9001, name: 'AccessX visit vis_abcdefghijkl', startAt: start, endAt: end });
  assert.ok(validKeypadCode(out.keyboardPwd), out.keyboardPwd);
  const stored = cloud.auths(9001).find(a => a.id === out.keyboardPwdId);
  assert.ok(stored, 'the ref is Nuki\'s auth id');
  assert.equal(String(stored.code), out.keyboardPwd);
  assert.equal(stored.allowedWeekDays, 127, 'weekdays sent, or Nuki ignores the window');
  assert.equal(stored.windowIgnored, false);
  assert.equal(stored.allowedFromDate, start);
  assert.equal(stored.allowedUntilDate, end);
  assert.ok(stored.name.length <= 20, stored.name);
  assert.equal(cloud.state.calls.filter(c => c.method === 'GET' && c.path === '/smartlock/9001/auth').length, 3, 'one look before creating (used codes), two until it shows');

  const listed = await v.listPasscodes(9001);
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(out.keyboardPwd), 'no digits in the list');

  await assert.rejects(v.createPasscode({ lockId: 9002, name: 'x', startAt: start, endAt: end }), e => e.status === 409 && /no keypad/.test(e.message));
  await assert.rejects(v.createPasscode({ lockId: 9004, name: 'x', startAt: start, endAt: end }), e => e.status === 409 && /offline/.test(e.message));
  await assert.rejects(v.createPasscode({ lockId: 9101, name: 'x', startAt: start, endAt: end }), e => e.status === 404, 'another account\'s lock');

  // Never confirmed: an error, and nothing is claimed.
  cloud.state.neverConfirm.add(9003);
  await assert.rejects(v.createPasscode({ lockId: 9003, name: 'x', startAt: start, endAt: end }), e => e.status === 503 && e.reason === 'unconfirmed');
  cloud.state.neverConfirm.delete(9003);

  assert.deepEqual(await v.deletePasscode(9001, out.keyboardPwdId), { deleted: true });
  assert.equal(cloud.auths(9001).length, 0);
  assert.deepEqual(await v.deletePasscode(9001, out.keyboardPwdId), { deleted: true, alreadyGone: true }, 'idempotent');
  await assert.rejects(v.deletePasscode(9004, 'a1'), e => e.code === 'NO_GATEWAY');

  await v.unlock(9001);
  const recs = await v.records(9001);
  assert.equal(recs[0].typeLabel, 'unlock (web)');
  assert.equal(recs[0].success, 1);
  assert.ok(!('keyboardPwd' in recs[0]), 'no code in records: arrivals are not matched from Nuki logs');
  await assert.rejects(v.unlock(9004), e => e.code === 'NO_GATEWAY');

  cloud.state.rateLimitNext = 1;
  v.invalidate();
  await assert.rejects(v.listLocks(), e => e.status === 503 && e.reason === 'unavailable');
  cloud.revoke('nuki-river-token');
  await assert.rejects(v.listLocks(), e => e.status === 503 && e.reason === 'needs_reconnect');
  assert.equal(authFailures, 1);
});

test('Nuki adapter: every shape of `code` works (number, string, array)', async () => {
  for (const codeShape of ['number', 'string', 'array']) {
    const cloud = nukiFixture({ codeShape });
    const v = vendorOn(cloud);
    const a = await v.createPasscode({ lockId: 9001, name: 'a', startAt: soon(1), endAt: soon(2) });
    const b = await v.createPasscode({ lockId: 9001, name: 'b', startAt: soon(1), endAt: soon(2) });
    assert.notEqual(a.keyboardPwd, b.keyboardPwd, codeShape);
    assert.notEqual(a.keyboardPwdId, b.keyboardPwdId, codeShape);
  }
});

test('a tenant on Nuki: connect with an API token, issue and revoke codes, sweep, token revoked → 503 + reconnect', async t => {
  const cloud = nukiFixture();
  const base = await cloud.listen(0);
  t.after(() => cloud.close());
  const api = await boot({ ADMIN_TOKEN: 'owner-token', NUKI_API_BASE: base, NUKI_POLL_MS: '50', RECONCILE_INTERVAL_MIN: '0', SECRETS_KEY: crypto.randomBytes(32).toString('base64') });
  t.after(api.close);

  assert.equal((await api.call('PUT', '/api/vendor-account', { ...OWNER, body: { kind: 'nuki', apiToken: 'wrong-token-0123456789' } })).status, 400);
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...OWNER, body: { kind: 'nuki' } })).status, 400);
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...OWNER, body: { kind: 'august', apiToken: 'x'.repeat(20) } })).status, 400);
  const readOnly = await api.call('PUT', '/api/vendor-account', { ...OWNER, body: { kind: 'nuki', apiToken: 'nuki-readonly-token' } });
  assert.equal(readOnly.status, 400, 'a token without smartlock.auth is refused at connect, not at the first visitor');
  assert.match(readOnly.body.error, /smartlock\.auth/);
  const c = await api.call('PUT', '/api/vendor-account', { ...OWNER, body: { kind: 'nuki', apiToken: 'nuki-river-token' } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.account.kind, 'nuki');
  assert.equal(c.body.account.lockCount, 4);
  assert.equal(c.body.account.tokenExpiresAt, null, 'API tokens do not expire');
  assert.ok(!JSON.stringify(c.body).includes('nuki-river-token'), 'the token is never returned');

  const doors = (await api.call('GET', '/api/doors', OWNER)).body;
  assert.equal(doors.demo, false);
  assert.deepEqual(doors.doors.map(d => d.lockId).sort(), [9001, 9002, 9003, 9004]);

  const issued = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9001, userId: 'u1', acknowledgeScheduleGap: true } });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const code = issued.body.passcode.keyboardPwd;
  assert.ok(validKeypadCode(code), `a Nuki keypad code: ${code}`);
  const cred = issued.body.credential;
  assert.equal(cloud.auths(9001).find(a => a.id === cred.vendorRef).allowedWeekDays, 127);

  const noKeypad = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9002, userId: 'u2', acknowledgeScheduleGap: true } });
  assert.equal(noKeypad.status, 409);
  assert.match(noKeypad.body.error, /no keypad/, 'the reason reaches the operator');

  const revoked = await api.call('DELETE', `/api/credentials/${cred.id}`, { ...OWNER, body: { reason: 'left' } });
  assert.equal(revoked.body.credential.status, 'revoked', JSON.stringify(revoked.body));
  assert.equal(cloud.auths(9001).length, 0, 'deleted on Nuki');

  // The R18 sweep works on Nuki: a code someone added in the Nuki app.
  cloud.addAppCode(9003, { name: 'Installer', code: 999999 });
  const sweep = await api.call('POST', '/api/passcode-sweep', { ...OWNER, body: {} });
  assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
  assert.equal(sweep.body.summary.unknown, 1);
  assert.ok(!JSON.stringify(sweep.body).includes('999999'), 'no digits');
  const stranger = sweep.body.locks.find(l => l.lockId === 9003).codes[0];
  assert.equal((await api.call('POST', '/api/passcode-sweep/remove', { ...OWNER, body: { lockId: 9003, refs: [stranger.ref] } })).body.results[0].ok, true);
  assert.equal(cloud.auths(9003).length, 0);
  assert.equal((await api.call('POST', '/api/passcode-sweep/remove', { ...OWNER, body: { lockId: 9004, refs: ['a1'] } })).status, 409, 'offline = no gateway');

  const audit = JSON.stringify((await api.call('GET', '/api/audit?limit=100', OWNER)).body.log);
  assert.match(audit, /vendor\.connect.*nuki uid=81001 locks=4/);
  assert.ok(!audit.includes('nuki-river-token') && !audit.includes(code), 'no token or code in the audit trail');

  // The token dies (Nuki Web password changed): a reason, never an empty fleet.
  // The lock list is cached for a minute; the next call that reaches Nuki finds out.
  cloud.revoke('nuki-river-token');
  const failed = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9001, userId: 'u1', acknowledgeScheduleGap: true } });
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.reason, 'needs_reconnect');
  const after = await api.call('GET', '/api/doors', OWNER);
  assert.equal(after.status, 503, JSON.stringify(after.body));
  assert.equal(after.body.reason, 'needs_reconnect');
  assert.equal((await api.call('GET', '/api/vendor-account', OWNER)).body.account.status, 'needs_reconnect');
  const back = await api.call('PUT', '/api/vendor-account', { ...OWNER, body: { kind: 'nuki', apiToken: 'nuki-gym-api-token' } });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.account.switchedAccount, true);
  assert.equal(back.body.account.status, 'connected');
});

test('offline Nuki lock: a revoked code waits as pending removal, and the reconciler deletes it once the lock is back online', async () => {
  const reconciler = require('../reconcile-core');
  const cloud = nukiFixture();
  const v = vendorOn(cloud);
  const out = await v.createPasscode({ lockId: 9003, name: 'Tom', startAt: soon(1), endAt: soon(48) });
  const snap = {
    sites: [{ id: 's1', name: 'Riverside', timezone: 'Europe/London' }], doorGroups: [], userGroups: [], schedules: [], assignments: [], holidays: [],
    users: [{ id: 'u4', name: 'Tom', groupIds: [], suspended: true }],
    credentials: [{ id: 'c1', type: 'passcode', userId: 'u4', lockId: 9003, status: 'active', endAt: soon(48), vendorRef: out.keyboardPwdId }],
  };
  const uow = () => { const calls = []; return { calls, update(c, id, patch) { calls.push({ id, ...patch }); return this; }, audit() { return this; } }; };

  cloud.state.locks[9003].serverState = 4; // the bridge lost Wi-Fi
  v.invalidate();
  let u = uow();
  let res = await reconciler.execute(reconciler.plan(snap, await v.listLocks()), { vendor: v, uow: u, snapshot: snap });
  assert.equal(res.summary.pendingRemoval, 1);
  assert.equal(u.calls[0].status, 'pending_removal');
  assert.equal(cloud.auths(9003).length, 1, 'still on the lock');

  snap.credentials[0] = { ...snap.credentials[0], status: 'pending_removal', revokedAt: new Date().toISOString(), revokeReason: 'suspended' };
  cloud.state.locks[9003].serverState = 0; // back online
  v.invalidate();
  u = uow();
  res = await reconciler.execute(reconciler.plan(snap, await v.listLocks()), { vendor: v, uow: u, snapshot: snap });
  assert.equal(res.summary.revoked, 1, JSON.stringify(res));
  assert.equal(u.calls[0].status, 'revoked');
  assert.equal(cloud.auths(9003).length, 0, 'deleted on Nuki without anyone visiting');
});
