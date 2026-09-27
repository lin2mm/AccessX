const assert = require('node:assert/strict');
const test = require('node:test');
const { boot } = require('../support/boot');
const { sha256Hex: sha256 } = require('../audit-core');

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

test('a passcode can start later, on the door clock — so TTLock\'s 24 h first-use rule counts from the first day of use', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS });
  t.after(api.close);
  const owner = { token: 'owner-token' };
  const day = n => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(Date.now() + n * 864e5));
  const local = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(', ', 'T');
  const r = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u2', startLocal: `${day(3)}T08:00`, endLocal: `${day(10)}T00:00` } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(local(r.body.credential.startAt), `${day(3)}T08:00`);
  assert.equal(local(r.body.credential.endAt), `${day(10)}T00:00`);
  const rule = r.body.warnings.find(w => /within 24 h/.test(w));
  assert.ok(rule && rule.includes(`${day(4)} 08:00`), `deadline counts from the chosen start: ${rule}`);
  assert.ok(!r.body.warnings.some(w => /whole hours/.test(w)), 'already whole hours: no rounding notice');
  // Without an end: the default 7 days run from the start, not from now.
  const d = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u2', startLocal: `${day(3)}T08:00` } });
  assert.equal(Date.parse(d.body.credential.endAt) - Date.parse(d.body.credential.startAt), 7 * 864e5);
  for (const bad of ['tomorrow', `${day(3)} 08:00`]) {
    assert.equal((await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u2', startLocal: bad } })).status, 400, bad);
  }
  assert.equal((await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u2', startLocal: `${day(120)}T08:00` } })).status, 400, 'at most 90 days ahead');
  assert.equal((await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u2', startLocal: `${day(5)}T08:00`, endLocal: `${day(4)}T00:00` } })).status, 400, 'end before start');
});
