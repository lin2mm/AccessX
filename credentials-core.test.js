const assert = require('node:assert/strict');
const test = require('node:test');
const creds = require('./credentials-core');

const NOW = Date.parse('2026-09-28T09:00:00Z');
function db(overrides = {}) {
  return {
    sites: [{ id: 's', name: 'Site', timezone: 'Europe/London' }],
    doorGroups: [
      { id: 'front', siteId: 's', name: 'Front', lockIds: [1] },
      { id: 'server', siteId: 's', name: 'Server', lockIds: [2] },
    ],
    userGroups: [{ id: 'staff', name: 'Staff' }, { id: 'it', name: 'IT' }],
    schedules: [
      { id: 'office', name: 'Office Hours', windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:30' }] },
      { id: '247', name: '24/7', windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '23:59' }] },
    ],
    assignments: [
      { userGroupId: 'staff', doorGroupId: 'front', scheduleId: 'office' },
      { userGroupId: 'it', doorGroupId: 'server', scheduleId: '247' },
    ],
    users: [
      { id: 'sarah', name: 'Sarah', groupIds: ['staff'] },
      { id: 'dev', name: 'Dev', groupIds: ['it'] },
      { id: 'gone', name: 'Gone', groupIds: ['it'], suspended: true },
      { id: 'temp', name: 'Temp', groupIds: ['it'], validTo: '2026-10-01T00:00:00Z' },
    ],
    holidays: [],
    credentials: [],
    ...overrides,
  };
}

test('refuses passcodes for people the policy does not allow', () => {
  assert.equal(creds.planPasscode(db(), { lockId: 2, now: NOW }).status, 400); // no userId
  assert.equal(creds.planPasscode(db(), { userId: 'nobody', lockId: 2, now: NOW }).status, 404);
  assert.equal(creds.planPasscode(db(), { userId: 'gone', lockId: 2, now: NOW }).error, 'user suspended');
  assert.equal(creds.planPasscode(db(), { userId: 'sarah', lockId: 2, now: NOW }).status, 403); // no rule
});

test('24/7 rules are fully enforceable by the lock', () => {
  const plan = creds.planPasscode(db(), { userId: 'dev', lockId: 2, now: NOW });
  assert.equal(plan.ok, true);
  assert.equal(plan.credential.enforcement, 'lock');
  assert.equal(Date.parse(plan.credential.endAt) - NOW, 7 * 864e5); // default 7 days
});

test('daily schedules need explicit acknowledgement and are marked partial', () => {
  const refused = creds.planPasscode(db(), { userId: 'sarah', lockId: 1, now: NOW });
  assert.equal(refused.status, 409);
  assert.match(refused.detail, /Office Hours/);
  const accepted = creds.planPasscode(db(), { userId: 'sarah', lockId: 1, now: NOW, acknowledgeScheduleGap: true });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.credential.enforcement, 'partial');
  assert.match(accepted.warnings.join(), /cannot enforce/);
});

test('validity is clamped to the user contract and the maximum', () => {
  const temp = creds.planPasscode(db(), { userId: 'temp', lockId: 2, now: NOW, endAt: '2026-12-31T00:00:00Z' });
  assert.equal(temp.credential.endAt, '2026-10-01T00:00:00.000Z');
  const long = creds.planPasscode(db(), { userId: 'dev', lockId: 2, now: NOW, endAt: '2030-01-01T00:00:00Z' });
  assert.equal(Date.parse(long.credential.endAt) - NOW, 90 * 864e5);
  assert.equal(creds.planPasscode(db(), { userId: 'dev', lockId: 2, now: NOW, endAt: '2020-01-01' }).status, 403);
  assert.equal(creds.planPasscode(db(), { userId: 'dev', lockId: 2, now: NOW, endAt: 'garbage' }).status, 400);
});

test('review flags credentials the policy would no longer issue', () => {
  const d = db();
  const plan = creds.planPasscode(d, { userId: 'dev', lockId: 2, now: NOW });
  const entry = creds.register(d, plan.credential, { issuedBy: 'owner', code: '123456' });
  assert.equal(entry.codeHint, '••••56');
  assert.equal(JSON.stringify(d).includes('123456'), false); // full code never stored
  assert.deepEqual(creds.reviewCredentials(d, NOW), []);

  d.users.find(u => u.id === 'dev').suspended = true;
  d.assignments = d.assignments.filter(a => a.userGroupId !== 'it');
  const [flag] = creds.reviewCredentials(d, NOW);
  assert.deepEqual(flag.reasons, ['user suspended', 'no rule grants this door any more']);

  creds.revoke(d, entry.id, { revokedBy: 'owner' });
  assert.deepEqual(creds.reviewCredentials(d, NOW), []);
});

test('isAlwaysOpen recognises 24/7 schedules only', () => {
  assert.equal(creds.isAlwaysOpen(null), true);
  assert.equal(creds.isAlwaysOpen(db().schedules[1]), true);
  assert.equal(creds.isAlwaysOpen(db().schedules[0]), false);
  assert.equal(creds.isAlwaysOpen({ ...db().schedules[1], denyOnHolidays: true }), false);
});
