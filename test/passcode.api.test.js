const assert = require('node:assert/strict');
const test = require('node:test');
const { boot } = require('../support/boot');
const { sha256 } = require('../auth');

const OPERATORS = JSON.stringify([
  { id: 'op_gym', name: 'Gym manager', role: 'r_manager', siteIds: ['site_gym'], tokenSha256: sha256('gym-token') },
]);

test('passcodes go through the policy engine and are registered', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS });
  t.after(api.close);
  const owner = { token: 'owner-token' };

  // Old behaviour allowed a code for anyone; now a person is required.
  assert.equal((await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002 } })).status, 400);
  // Suspended ex-employee (u5) cannot get a code.
  const ex = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9001, userId: 'u5' } });
  assert.equal(ex.status, 403);
  // Sarah (Office Staff) has no rule for the Server Room.
  assert.equal((await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u1' } })).status, 403);
  // Dev (IT, 24/7) gets a fully lock-enforced code.
  const dev = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u2' } });
  assert.equal(dev.status, 200);
  assert.equal(dev.body.credential.enforcement, 'lock');
  assert.match(dev.body.passcode.keyboardPwd, /^\d{6}$/);

  const list = await api.call('GET', '/api/credentials', owner);
  assert.equal(list.body.credentials.length, 1);
  assert.equal(list.body.credentials[0].codeHint.endsWith(dev.body.passcode.keyboardPwd.slice(-2)), true);

  const log = await api.call('GET', '/api/audit', owner);
  assert.deepEqual(log.body.log.slice(0, 4).map(e => e.action),
    ['passcode.create', 'passcode.denied', 'passcode.denied', 'passcode.denied']);
});

test('schedule gap requires acknowledgement', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const body = { lockId: 9001, userId: 'u1' }; // Sarah, Office Hours
  const refused = await api.call('POST', '/api/passcode', { token: 'owner-token', body });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.needs, 'acknowledgeScheduleGap');
  const ok = await api.call('POST', '/api/passcode', { token: 'owner-token', body: { ...body, acknowledgeScheduleGap: true } });
  assert.equal(ok.body.credential.enforcement, 'partial');
});

test('site managers can only issue and revoke at their sites', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS });
  t.after(api.close);
  const office = await api.call('POST', '/api/passcode', { token: 'gym-token', body: { lockId: 9002, userId: 'u2' } });
  assert.equal(office.status, 403);
  const gym = await api.call('POST', '/api/passcode', { token: 'gym-token', body: { lockId: 9101, userId: 'u4' } });
  assert.equal(gym.status, 200);
  const id = gym.body.credential.id;
  const revoked = await api.call('DELETE', `/api/credentials/${id}`, { token: 'gym-token' });
  assert.equal(revoked.body.credential.status, 'revoked');
});
