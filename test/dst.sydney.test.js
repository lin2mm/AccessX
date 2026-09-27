/**
 * Sydney daylight saving, 4 October 2026: at 02:00 AEST (+10) clocks jump
 * to 03:00 AEDT (+11). 02:00–02:59 does not exist that night.
 * Schedules are wall-clock rules evaluated per instant in the site's zone;
 * period passcodes are absolute instants (TTLock startDate/endDate in ms)
 * and therefore unaffected — the risk is the LOCK'S clock, which is why the
 * reconciler raises a notice for offline locks at DST sites.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../policy-core');
const reconciler = require('../reconcile-core');

const TZ = 'Australia/Sydney';
const Z = s => new Date(s);
const db = {
  sites: [{ id: 's_syd', name: 'Sydney Office', timezone: TZ }],
  doorGroups: [{ id: 'dg_front', siteId: 's_syd', name: 'Front', lockIds: [7001] }, { id: 'dg_store', siteId: 's_syd', name: 'Store', lockIds: [7002] }],
  userGroups: [{ id: 'ug_staff', siteId: 's_syd', name: 'Staff' }, { id: 'ug_night', siteId: 's_syd', name: 'Night' }],
  users: [{ id: 'u_day', name: 'Day', groupIds: ['ug_staff'] }, { id: 'u_night', name: 'Night', groupIds: ['ug_night'] }],
  schedules: [
    { id: 'sch_office', name: 'Office', windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:30' }] },
    { id: 'sch_night', name: 'Night shift', windows: [{ days: [6], from: '22:00', to: '06:00' }] }, // Saturday night
  ],
  assignments: [
    { id: 'a1', userGroupId: 'ug_staff', doorGroupId: 'dg_front', scheduleId: 'sch_office' },
    { id: 'a2', userGroupId: 'ug_night', doorGroupId: 'dg_front', scheduleId: 'sch_night' },
  ],
  holidays: [], roles: [], credentials: [], settings: {},
};
const allowed = (userId, iso) => policy.evaluate(db, userId, 7001, Z(iso)).allowed;

test('wall-clock conversion across the spring-forward gap', () => {
  assert.equal(policy.zonedTimeToDate('2026-10-04T01:59', TZ).toISOString(), '2026-10-03T15:59:00.000Z'); // AEST +10
  assert.equal(policy.zonedTimeToDate('2026-10-04T03:00', TZ).toISOString(), '2026-10-03T16:00:00.000Z'); // AEDT +11
  // 02:30 does not exist: pushed forward by the gap to 03:30 AEDT (same as Temporal "compatible").
  const gap = policy.zonedTimeToDate('2026-10-04T02:30', TZ);
  assert.equal(gap.toISOString(), '2026-10-03T16:30:00.000Z');
  assert.equal(policy.localParts(gap, TZ).label, '2026-10-04 03:30 Australia/Sydney');
  // One real minute after 01:59 AEST is 03:00 AEDT.
  assert.equal(policy.localParts(Z('2026-10-03T16:00:00Z'), TZ).label, '2026-10-04 03:00 Australia/Sydney');
});

test('office hours follow the wall clock before and after the change', () => {
  // Friday 2 Oct (AEST): 08:00 local = 22:00Z the day before.
  assert.equal(allowed('u_day', '2026-10-01T21:59:00Z'), false);
  assert.equal(allowed('u_day', '2026-10-01T22:00:00Z'), true);
  // Monday 5 Oct (AEDT): 08:00 local = 21:00Z — one hour earlier in UTC.
  assert.equal(allowed('u_day', '2026-10-04T20:59:00Z'), false);
  assert.equal(allowed('u_day', '2026-10-04T21:00:00Z'), true);
  assert.equal(allowed('u_day', '2026-10-05T07:30:00Z'), true);  // 18:30 AEDT
  assert.equal(allowed('u_day', '2026-10-05T07:31:00Z'), false);
});

test('overnight shift spanning the gap is 7 real hours, and never open in the missing hour', () => {
  // Saturday 22:00 AEST = 12:00Z; Sunday 06:00 AEDT = 19:00Z.
  let open = 0;
  let first = null;
  let last = null;
  for (let t = Date.parse('2026-10-03T10:00:00Z'); t <= Date.parse('2026-10-03T21:00:00Z'); t += 60e3) {
    if (policy.evaluate(db, 'u_night', 7001, new Date(t)).allowed) {
      open++;
      first ??= t;
      last = t;
    }
  }
  assert.equal(new Date(first).toISOString(), '2026-10-03T12:00:00.000Z');
  assert.equal(new Date(last).toISOString(), '2026-10-03T19:00:00.000Z');
  assert.equal(open, 7 * 60 + 1, 'wall clock 22:00→06:00 is 7h on DST night (inclusive end minute)');
  // The last AEST minute and the first AEDT minute are both inside the shift.
  assert.equal(allowed('u_night', '2026-10-03T15:59:00Z'), true);
  assert.equal(allowed('u_night', '2026-10-03T16:00:00Z'), true);
});

test('fall-back (5 April 2026): the repeated hour is evaluated on the wall clock both times', () => {
  // 03:00 AEDT → 02:00 AEST. 02:30 local occurs at 15:30Z and at 16:30Z.
  assert.equal(policy.localParts(Z('2026-04-04T15:30:00Z'), TZ).label, '2026-04-05 02:30 Australia/Sydney');
  assert.equal(policy.localParts(Z('2026-04-04T16:30:00Z'), TZ).label, '2026-04-05 02:30 Australia/Sydney');
  // Ambiguous input resolves to the EARLIER instant (RFC 5545 / Temporal
  // "compatible"): an end time of 02:30 must not grant the repeated hour.
  assert.equal(policy.zonedTimeToDate('2026-04-05T02:30', TZ).toISOString(), '2026-04-04T15:30:00.000Z');
  assert.equal(policy.zonedTimeToDate('2026-04-05T02:30', TZ, { prefer: 'later' }).toISOString(), '2026-04-04T16:30:00.000Z');
  // Edges of the repeated hour: 02:00 is ambiguous, 03:00 is not.
  assert.equal(policy.zonedTimeToDate('2026-04-05T02:00', TZ).toISOString(), '2026-04-04T15:00:00.000Z');
  assert.equal(policy.zonedTimeToDate('2026-04-05T03:00', TZ).toISOString(), '2026-04-04T17:00:00.000Z');
  assert.equal(policy.zonedTimeToDate('2026-04-05T01:59', TZ).toISOString(), '2026-04-04T14:59:00.000Z');
});

test('spring-forward gap (4 October 2026): 02:30 does not exist and resolves to 03:30 AEDT', () => {
  const t = policy.zonedTimeToDate('2026-10-04T02:30', TZ);
  assert.equal(t.toISOString(), '2026-10-03T16:30:00.000Z');
  assert.equal(policy.localParts(t, TZ).label, '2026-10-04 03:30 Australia/Sydney');
  assert.equal(policy.zonedTimeToDate('2026-10-04T03:00', TZ).toISOString(), '2026-10-03T16:00:00.000Z');
  // Southern and northern hemisphere, and a 30-minute DST zone (Lord Howe).
  assert.equal(policy.zonedTimeToDate('2026-10-25T01:30', 'Europe/London').toISOString(), '2026-10-25T00:30:00.000Z', 'London fall-back: earlier (BST)');
  assert.equal(policy.zonedTimeToDate('2026-04-05T01:45', 'Australia/Lord_Howe').toISOString(), '2026-04-04T14:45:00.000Z', 'Lord Howe: earlier (+11)');
});

test('reconciler warns a week ahead, naming the locks that cannot get a clock correction', () => {
  const locks = [{ lockId: 7001, hasGateway: true }, { lockId: 7002, hasGateway: false }];
  assert.deepEqual(reconciler.nextOffsetChange(TZ, Date.parse('2026-09-27T00:00:00Z'), 14), { date: '2026-10-04', shiftMinutes: 60 });
  const planned = reconciler.plan(db, locks, { now: Date.parse('2026-09-27T00:00:00Z') });
  const n = planned.notices.find(x => x.type === 'dst');
  assert.equal(n.site, 'Sydney Office');
  assert.equal(n.date, '2026-10-04');
  assert.equal(n.shiftMinutes, 60);
  assert.deepEqual(n.offlineLocks, [7002]);
  assert.match(n.advice, /without a gateway/);
  // After the change there is no notice until April.
  assert.equal(reconciler.plan(db, locks, { now: Date.parse('2026-10-05T00:00:00Z') }).notices.filter(x => x.type === 'dst').length, 0);
});

test('passcode endLocal is converted in the door\'s time zone, not the admin\'s', async t => {
  const { boot } = require('../support/boot');
  const api = await boot({ ADMIN_TOKEN: 'o', TZ: 'America/Los_Angeles' });
  t.after(api.close);
  // Riverside (seed) is Europe/London: 20 Oct is still BST (+1) → 22:59Z, whatever the server/admin zone.
  const r = await api.call('POST', '/api/passcode', { token: 'o', body: { lockId: 9002, userId: 'u2', endLocal: '2026-10-20T23:59' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.credential.endAt, '2026-10-20T22:59:00.000Z');
  assert.equal((await api.call('POST', '/api/passcode', { token: 'o', body: { lockId: 9002, userId: 'u2', endLocal: 'soon' } })).status, 400);
  // The UI labels, prefills and displays in the zone /api/doors reports — it must be the one used above.
  const doors = (await api.call('GET', '/api/doors', { token: 'o' })).body.doors;
  assert.ok(doors.length && doors.every(d => typeof d.timeZone === 'string' && d.timeZone), 'every door carries its time zone');
  assert.equal(doors.find(d => d.lockId === 9002).timeZone, 'Europe/London');
});
