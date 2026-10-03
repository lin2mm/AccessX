const assert = require('node:assert/strict');
const test = require('node:test');
const compiler = require('./compiler-core');

const NOW = Date.parse('2026-09-28T09:00:00Z');
function db(timezone = 'Asia/Shanghai', schedule = {}) {
  return {
    sites: [{ id: 's', name: 'Site', timezone }],
    doorGroups: [{ id: 'dg', siteId: 's', name: 'Doors', lockIds: [1, 2, 3] }],
    userGroups: [{ id: 'g', name: 'Staff' }],
    users: [{ id: 'u1', groupIds: ['g'] }, { id: 'u2', groupIds: ['g'], suspended: true }],
    schedules: [{ id: 'sc', name: 'Sched', windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }], ...schedule }],
    assignments: [{ id: 'a', userGroupId: 'g', doorGroupId: 'dg', scheduleId: 'sc' }],
    holidays: [{ date: '2026-10-01', siteId: 's' }],
  };
}
const LOCKS = [
  { lockId: 1, name: 'Smart', hasGateway: true, cyclic: true },
  { lockId: 2, name: 'Basic', hasGateway: true, cyclic: false },
  { lockId: 3, name: 'Offline', hasGateway: false, cyclic: true },
];
const door = (report, id) => report.rules[0].doors.find(d => d.lockId === id);

test('weekly windows are lock-enforced only where the lock supports them', () => {
  const r = compiler.compile(db(), LOCKS, { now: NOW }); // Shanghai: no DST
  assert.equal(door(r, 1).level, 'lock');
  assert.equal(door(r, 2).level, 'cloud');
  assert.equal(door(r, 3).level, 'lock');
  assert.equal(r.rules[0].level, 'cloud'); // a rule is only as strong as its weakest door
  assert.equal(r.rules[0].members, 1);     // suspended users get no credentials
});

test('holidays need a gateway; without one they cannot be enforced', () => {
  const r = compiler.compile(db('Asia/Shanghai', { denyOnHolidays: true }), LOCKS, { now: NOW });
  assert.equal(door(r, 1).level, 'synced');
  assert.equal(door(r, 3).level, 'cloud');
});

test('DST zones downgrade cyclic windows to synced (fixed-offset lock clocks)', () => {
  assert.equal(compiler.observesDst('Europe/London'), true);
  assert.equal(compiler.observesDst('Australia/Sydney'), true);
  assert.equal(compiler.observesDst('Asia/Shanghai'), false);
  const r = compiler.compile(db('Europe/London'), LOCKS, { now: NOW });
  assert.equal(door(r, 1).level, 'synced');
  assert.match(door(r, 1).reasons.map(x => x.text).join(), /daylight saving/);
});

test('24/7 rules are fully lock-enforced everywhere', () => {
  const r = compiler.compile(db('Europe/London', { windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '23:59' }] }), LOCKS, { now: NOW });
  assert.deepEqual(r.rules[0].doors.map(d => d.level), ['lock', 'lock', 'lock']);
  assert.equal(r.summary.fullyEnforcedPct, 100);
});

test('overnight windows are split into lock-native slots', () => {
  const slots = compiler.compileWindows({ windows: [{ days: [5, 7], from: '22:00', to: '06:00' }] });
  assert.deepEqual(slots, [
    { weekDay: 1, startMin: 0, endMin: 360 },    // Sun night → Mon morning
    { weekDay: 5, startMin: 1320, endMin: 1439 },
    { weekDay: 6, startMin: 0, endMin: 360 },
    { weekDay: 7, startMin: 1320, endMin: 1439 },
  ]);
});

test('lock report lists operational issues', () => {
  const r = compiler.compile(db(), LOCKS, { now: NOW });
  const offline = r.locks.find(l => l.lockId === 3);
  assert.match(offline.issues.join(), /on-site visit/);
  assert.equal(r.locks.find(l => l.lockId === 1).desiredCredentials, 1);
});
