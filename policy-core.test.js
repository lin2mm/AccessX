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

/* ---------------- time zones ---------------- */

function londonFixture(overrides = {}) {
  return fixture({
    sites: [{ id: 'site-1', name: 'Bristol', timezone: 'Europe/London' }],
    ...overrides,
  });
}

test('evaluates schedules in the site time zone (British Summer Time)', () => {
  const db = londonFixture();
  // 07:30 UTC on a July Wednesday is 08:30 BST — inside 08:00-18:00.
  const morning = new Date('2026-07-01T07:30:00Z');
  assert.equal(policy.evaluate(db, 'user-1', 9001, morning).allowed, true);
  // 17:30 UTC is 18:30 BST — after hours, even though it is before 18:00 UTC.
  const evening = new Date('2026-07-01T17:30:00Z');
  assert.equal(policy.evaluate(db, 'user-1', 9001, evening).allowed, false);
});

test('the same instant can be allowed in one site and denied in another', () => {
  const db = fixture({ sites: [{ id: 'site-1', name: 'Site', timezone: 'Australia/Sydney' }] });
  const instant = new Date('2026-07-07T23:00:00Z');
  const cases = {
    'Australia/Sydney': true,     // Wed 09:00 AEST
    'America/Los_Angeles': true,  // Tue 16:00 PDT
    'Asia/Tokyo': true,           // Wed 08:00 JST (window starts 08:00)
    'Pacific/Auckland': true,     // Wed 11:00 NZST
    'Europe/London': false,       // Wed 00:00 BST
    'Asia/Shanghai': false,       // Wed 07:00 CST
  };
  for (const [timeZone, expected] of Object.entries(cases)) {
    db.sites[0].timezone = timeZone;
    assert.equal(policy.evaluate(db, 'user-1', 9001, instant).allowed, expected, timeZone);
  }
});

test('holidays match the site-local calendar date', () => {
  const db = fixture({
    sites: [{ id: 'site-1', name: 'Sydney', timezone: 'Australia/Sydney' }],
    holidays: [{ date: '2026-10-05', siteId: 'site-1', name: 'Labour Day' }],
  });
  // 2026-10-04T23:30Z is Monday 5 Oct 10:30 in Sydney (AEDT) — a holiday there.
  const result = policy.evaluate(db, 'user-1', 9001, new Date('2026-10-04T23:30:00Z'));
  assert.equal(result.allowed, false);
  assert.match(result.path[0].reason, /holiday/);
});

test('overnight windows carry into the next morning for the starting day only', () => {
  const db = londonFixture({
    schedules: [{ id: 'weekday', name: 'Friday night', windows: [{ days: [5], from: '22:00', to: '06:00' }] }],
  });
  // Saturday 02:00 London (GMT in January) belongs to the Friday window.
  assert.equal(policy.evaluate(db, 'user-1', 9001, new Date('2026-01-10T02:00:00Z')).allowed, true);
  // Friday 02:00 belongs to Thursday — not granted.
  assert.equal(policy.evaluate(db, 'user-1', 9001, new Date('2026-01-09T02:00:00Z')).allowed, false);
  // Friday 23:00 is inside.
  assert.equal(policy.evaluate(db, 'user-1', 9001, new Date('2026-01-09T23:00:00Z')).allowed, true);
});

test('zonedTimeToDate converts site-local wall-clock time, including DST', () => {
  assert.equal(policy.zonedTimeToDate('2026-07-01T21:00', 'Europe/London').toISOString(), '2026-07-01T20:00:00.000Z');
  assert.equal(policy.zonedTimeToDate('2026-01-01T21:00', 'Europe/London').toISOString(), '2026-01-01T21:00:00.000Z');
  assert.equal(policy.zonedTimeToDate('2026-10-05T09:00', 'Australia/Sydney').toISOString(), '2026-10-04T22:00:00.000Z');
  // 01:30 on the spring-forward day does not exist in London; resolves after the gap.
  const gap = policy.zonedTimeToDate('2026-03-29T01:30', 'Europe/London');
  assert.equal(policy.localParts(gap, 'Europe/London').hour, 2);
  assert.ok(Number.isNaN(policy.zonedTimeToDate('not a date', 'UTC').getTime()));
});

test('unknown time zones fall back to UTC instead of throwing', () => {
  assert.equal(policy.isValidTimeZone('Mars/Olympus'), false);
  const db = fixture({ sites: [{ id: 'site-1', name: 'X', timezone: 'Mars/Olympus' }] });
  assert.equal(policy.evaluate(db, 'user-1', 9001, new Date('2026-09-28T09:00:00Z')).allowed, true);
});
