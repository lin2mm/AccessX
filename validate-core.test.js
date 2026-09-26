const assert = require('node:assert/strict');
const test = require('node:test');
const { validate, referencedBy, escapeHtml } = require('./validate-core');

const db = {
  sites: [{ id: 's1' }], userGroups: [{ id: 'g1' }], doorGroups: [{ id: 'd1', siteId: 's1' }],
  schedules: [{ id: 'sc1' }], users: [{ id: 'u1', groupIds: ['g1'] }],
  assignments: [{ id: 'a1', userGroupId: 'g1', doorGroupId: 'd1', scheduleId: 'sc1' }], holidays: [],
};

test('accepts well-formed records and normalises them', () => {
  const user = validate('users', { name: '  Ana  ', email: 'ana@x.io', groupIds: ['g1', 'g1'], validTo: '2027-01-01' }, db);
  assert.deepEqual(user, { name: 'Ana', email: 'ana@x.io', groupIds: ['g1'], validTo: '2027-01-01T00:00:00.000Z' });
  const schedule = validate('schedules', { name: 'Nights', windows: [{ days: [5, 1, 5], from: '22:00', to: '06:00' }] }, db);
  assert.deepEqual(schedule.windows, [{ days: [1, 5], from: '22:00', to: '06:00' }]);
});

test('rejects unknown fields, bad types, bad references and broken schedules', () => {
  assert.throws(() => validate('users', { name: 'x', isAdmin: true }, db), /unknown field/);
  assert.throws(() => validate('users', { name: 42 }, db), /must be a string/);
  assert.throws(() => validate('users', { name: 'x', groupIds: ['nope'] }, db), /existing userGroups/);
  assert.throws(() => validate('users', { name: 'x', email: '<svg onload=alert(1)>@x.y' }, db), /valid email/);
  assert.throws(() => validate('schedules', { name: 'x', windows: [{ from: '08:00', to: '18:00' }] }, db), /days/);
  assert.throws(() => validate('schedules', { name: 'x', windows: [{ days: [8], from: '08:00', to: '18:00' }] }, db), /days/);
  assert.throws(() => validate('schedules', { name: 'x', windows: [{ days: [1], from: '8am', to: '18:00' }] }, db), /HH:MM/);
  assert.throws(() => validate('sites', { name: 'x', timezone: 'Mars/Base' }, db), /IANA/);
  assert.throws(() => validate('doorGroups', { name: 'x', siteId: 's1', lockIds: [-1] }, db), /positive integer/);
  assert.throws(() => validate('roles', { name: 'x', perms: ['god.mode'] }, db), /unknown permission/);
  assert.throws(() => validate('users', { name: 'x', validFrom: '2027-01-02', validTo: '2027-01-01' }, db), /before/);
  assert.throws(() => validate('users', { name: 'a\u0000b' }, db), /control characters/);
  assert.throws(() => validate('users', ['x'], db), /JSON object/);
});

test('finds references that would dangle on delete', () => {
  assert.deepEqual(referencedBy('userGroups', 'g1', db), ['users/u1', 'assignments/a1']);
  assert.deepEqual(referencedBy('sites', 's1', db), ['doorGroups/d1']);
  assert.deepEqual(referencedBy('holidays', 'h1', db), []);
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('x')">&`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
});
