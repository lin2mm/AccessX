const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');

const OWNER = { token: 'owner-token' };
const O2 = { token: 'o2-token' };
const OPERATORS = JSON.stringify([{ id: 'op_o2', name: 'Second owner', role: 'r_owner', tokenSha256: sha256Hex('o2-token') }]);
const SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');

async function setup(t) {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  return api;
}
// A weekday 10:00, a few weeks out (demo "Office hours" apply).
const weekdayAt10 = () => { const d = new Date(Date.now() + 21 * 864e5); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return `${d.toISOString().slice(0, 10)}T10:00`; };
const allowed = async (api, userId, lockId) => (await api.call('POST', '/api/evaluate', { ...OWNER, body: { userId, lockId, localTime: weekdayAt10() } })).body.result.allowed;
const group = async (api, id) => (await api.call('GET', '/api/doorGroups', OWNER)).body.doorGroups.find(g => g.id === id);

test('a site-scoped admin cannot file another site\'s door under their site (create or edit)', async t => {
  const api = await setup(t);
  const role = await api.call('POST', '/api/roles', { ...OWNER, body: { name: 'Site admin', perms: ['door.read', 'rule.manage', 'user.manage'] } });
  const op = await api.call('POST', '/api/operators', { ...OWNER, body: { name: 'Gym admin', role: role.body.item.id, siteIds: ['site_gym'] } });
  const GYM = { token: op.body.token };
  const sneaky = await api.call('POST', '/api/doorGroups', { ...GYM, body: { name: 'Sneaky', siteId: 'site_gym', lockIds: [9001] } });
  assert.equal(sneaky.status, 403, 'the office front door is not theirs');
  assert.match(sneaky.body.detail || sneaky.body.error, /9001/);
  const ok = await api.call('POST', '/api/doorGroups', { ...GYM, body: { name: 'Gym extra', siteId: 'site_gym', lockIds: [9101] } });
  assert.equal(ok.status, 200, 'their own doors are fine');
  const add = await api.call('PATCH', `/api/doorGroups/${ok.body.item.id}`, { ...GYM, body: { lockIds: [9101, 9001] } });
  assert.equal(add.status, 403);
  assert.equal((await api.call('PATCH', '/api/doorGroups/dg_pub', { ...GYM, body: { name: 'Mine' } })).status, 404, 'other sites\' groups do not exist for them');
  assert.deepEqual((await group(api, ok.body.item.id)).lockIds, [9101]);
});

test('move a door between groups: add to the new group, remove from the old; audited; access follows', async t => {
  const api = await setup(t);
  // u1 is staff: Operations (9003, 9004) during office hours. Cleaners also get Operations.
  const staffUser = (await api.call('GET', '/api/users', OWNER)).body.users.find(u => (u.groupIds || []).includes('ug_staff') && !(u.groupIds || []).includes('ug_it'));
  assert.ok(staffUser);
  assert.equal(await allowed(api, staffUser.id, 9004), true);
  const pub = await api.call('PATCH', '/api/doorGroups/dg_pub', { ...OWNER, body: { lockIds: [9001, 9004] } });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const ops = await api.call('PATCH', '/api/doorGroups/dg_ops', { ...OWNER, body: { lockIds: [9003], name: 'Operations floor' } });
  assert.equal(ops.status, 200);
  assert.ok(ops.body.reconcile, 'a removal reconciles codes right away');
  assert.deepEqual((await group(api, 'dg_ops')).lockIds, [9003]);
  assert.equal((await group(api, 'dg_ops')).name, 'Operations floor');
  assert.equal(await allowed(api, staffUser.id, 9004), true, 'still allowed through Public Doors');
  const audit = (await api.call('GET', '/api/audit?limit=20', OWNER)).body;
  const entries = (audit.log || []).map(e => `${e.action} ${e.detail}`);
  assert.ok(entries.some(e => /doorGroups\.update dg_ops: name "Operations" -> "Operations floor"; -doors 9004/.test(e)), entries.join('\n'));
  assert.equal((await api.call('PATCH', '/api/doorGroups/dg_ops', { ...OWNER, body: { lockIds: [9003] } })).body.message, 'Nothing changed.');
  assert.equal((await api.call('PATCH', '/api/doorGroups/dg_ops', { ...OWNER, body: { siteId: 'site_gym' } })).status, 400, 'no moving groups between sites');
  assert.equal((await api.call('PATCH', '/api/doorGroups/dg_ops', { ...OWNER, body: { lockIds: ['x'] } })).status, 400);
  assert.equal((await api.call('PATCH', '/api/doorGroups/nope', { ...OWNER, body: { name: 'x' } })).status, 404);
});

test('four-eyes: widening access to a sensitive door or removing its protection waits for a second person', async t => {
  const api = await setup(t);
  const mark = await api.call('PATCH', '/api/doorGroups/dg_sec', { ...OWNER, body: { sensitive: true } });
  assert.equal(mark.status, 200, 'making a group sensitive only restricts: immediate');
  assert.equal((await group(api, 'dg_sec')).sensitive, true);

  const widen = await api.call('PATCH', '/api/doorGroups/dg_pub', { ...OWNER, body: { lockIds: [9001, 9002] } });
  assert.equal(widen.status, 202, 'staff would get the server room');
  assert.deepEqual(widen.body.approval.locks, [9002]);
  assert.deepEqual((await group(api, 'dg_pub')).lockIds, [9001], 'nothing changed yet');
  const ok = await api.call('POST', `/api/approvals/${widen.body.approval.id}/approve`, { ...O2, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual((await group(api, 'dg_pub')).lockIds, [9001, 9002], 'applied on approval');

  const unprotect = await api.call('PATCH', '/api/doorGroups/dg_sec', { ...OWNER, body: { sensitive: false } });
  assert.equal(unprotect.status, 202);
  const remove = await api.call('PATCH', '/api/doorGroups/dg_sec', { ...OWNER, body: { lockIds: [] } });
  assert.equal(remove.status, 202, 'taking the door out of its sensitive group removes the protection');
  const rename = await api.call('PATCH', '/api/doorGroups/dg_sec', { ...OWNER, body: { name: 'Server room' } });
  assert.equal(rename.status, 200, 'a rename changes nobody\'s access');
  const narrow = await api.call('PATCH', '/api/doorGroups/dg_pub', { ...OWNER, body: { lockIds: [9001] } });
  assert.equal(narrow.status, 200, 'removing a sensitive door from an ordinary group only narrows access');
});
