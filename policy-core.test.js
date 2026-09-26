const assert = require('node:assert/strict');
const test = require('node:test');
const policy = require('./policy-core');

function fixture(overrides = {}) {
  return {
    sites: [{ id: 'site-1', name: 'Test site' }],
    doorGroups: [{ id: 'doors-1', siteId: 'site-1', name: 'Front door', lockIds: [9001] }],
    userGroups: [{ id: 'staff', name: 'Staff' }],
    users: [{ id: 'user-1', name: 'Test user', groupIds: ['staff'], suspended: false }],
    schedules: [{ id: 'weekday', name: 'Weekdays', denyOnHolidays: true, windows: [
      { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' },
    ] }],
    assignments: [{ userGroupId: 'staff', doorGroupId: 'doors-1', scheduleId: 'weekday' }],
    holidays: [],
    auditLog: [],
    ...overrides,
  };
}

test('allows an assigned user inside the scheduled window', () => {
  const db = fixture();
  const at = new Date('2026-09-28T09:00:00.000Z');
  assert.equal(policy.evaluate(db, 'user-1', 9001, at).allowed, true);
  assert.equal(policy.doorsForUser(db, 'user-1', at).length, 1);
});

test('denies access outside the schedule and on a blocked holiday', () => {
  const db = fixture({ holidays: [{ date: '2026-09-28', siteId: 'site-1' }] });
  assert.equal(policy.evaluate(db, 'user-1', 9001, new Date('2026-09-28T09:00:00Z')).allowed, false);
  assert.equal(policy.evaluate(db, 'user-1', 9001, new Date('2026-09-28T21:00:00Z')).allowed, false);
});

test('denies suspended, unknown, and unassigned users', () => {
  const db = fixture({ users: [
    { id: 'user-1', name: 'Suspended', groupIds: ['staff'], suspended: true },
    { id: 'user-2', name: 'Unassigned', groupIds: [], suspended: false },
  ] });
  const at = new Date('2026-09-28T09:00:00Z');
  assert.equal(policy.evaluate(db, 'user-1', 9001, at).reason, 'user suspended');
  assert.equal(policy.evaluate(db, 'user-2', 9001, at).allowed, false);
  assert.equal(policy.evaluate(db, 'missing', 9001, at).reason, 'unknown user');
});

test('audit records are newest-first and bounded', () => {
  const db = fixture();
  for (let i = 0; i < 2005; i++) policy.audit(db, 'test', String(i));
  assert.equal(db.auditLog.length, 2000);
  assert.equal(db.auditLog[0].detail, '2004');
  assert.equal(db.auditLog.at(-1).detail, '5');
});
