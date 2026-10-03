const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');
const { createFakeTTLock } = require('../support/fake-ttlock');
const onboarding = require('../onboarding-core');

const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

test('door names → kinds (secure first, then entrances, facilities, else offices)', () => {
  const k = onboarding.classify;
  assert.equal(k('Main Entrance'), 'entrance');
  assert.equal(k('Level 2 Lobby'), 'entrance');
  assert.equal(k('Server Room'), 'secure');
  assert.equal(k('Server room entrance'), 'secure', 'secure wins');
  assert.equal(k('Comms Room'), 'secure');
  assert.equal(k('IT store'), 'secure');
  assert.equal(k('Pharmacy'), 'secure');
  assert.equal(k("Cleaner's Cupboard"), 'facilities');
  assert.equal(k('Bike Store'), 'facilities');
  assert.equal(k('Kitchen'), 'office', 'staff need the kitchen');
  assert.equal(k('Meeting Room 1'), 'office');
  assert.equal(k('Suite 4'), 'office', 'no "it" inside words');
  assert.equal(k(''), 'office');
});

async function setup(t) {
  const cloud = createFakeTTLock({
    accounts: { 'acme-admin': { password: 'acme-pass', uid: '81001', lockIds: [7001, 7002, 7003, 7004, 7005, 7006, 7101, 7102, 7201] } },
    locks: {
      7001: { lockAlias: 'Front Door', hasGateway: true, electricQuantity: 90, groupName: 'Acme HQ' },
      7002: { lockAlias: 'Level 2 Lobby', hasGateway: true, electricQuantity: 90, groupName: 'Acme HQ' },
      7003: { lockAlias: 'Meeting Room 1', hasGateway: true, electricQuantity: 90, groupName: 'Acme HQ' },
      7004: { lockAlias: 'Kitchen', hasGateway: false, electricQuantity: 90, groupName: 'Acme HQ' },
      7005: { lockAlias: "Cleaner's Cupboard", hasGateway: false, electricQuantity: 90, groupName: 'Acme HQ' },
      7006: { lockAlias: 'Comms Room', hasGateway: true, electricQuantity: 90, groupName: 'Acme HQ' },
      7101: { lockAlias: 'Branch Entrance', hasGateway: true, electricQuantity: 90, groupName: 'Acme Branch' },
      7102: { lockAlias: 'Branch Office', hasGateway: true, electricQuantity: 90, groupName: 'Acme Branch' },
      7201: { lockAlias: 'Bike Store', hasGateway: false, electricQuantity: 90 },
    },
  });
  const base = await cloud.listen(0);
  const api = await boot({ ADMIN_TOKEN: 'owner-token', PLATFORM_TOKEN: 'pt', SECRETS_KEY, TTLOCK_API_BASE: base, TTLOCK_CLIENT_ID: 'platform-app', TTLOCK_CLIENT_SECRET: 'platform-secret', RECONCILE_INTERVAL_MIN: '0' });
  t.after(async () => { await api.close(); await cloud.close(); });
  const created = await api.call('POST', '/api/tenants', { token: 'pt', body: { name: 'Acme Offices' } });
  return { api, owner: { token: created.body.owner.token } };
}

test('office setup: connect TTLock → sites from TTLock groups → door groups → Office hours / Cleaning rules; secure rooms sensitive; re-run is a no-op', async t => {
  const { api, owner } = await setup(t);
  let g = await api.call('GET', '/api/onboarding/office', owner);
  assert.equal(g.status, 200);
  const done = list => Object.fromEntries(list.map(c => [c.id, c.done]));
  assert.equal(done(g.body.checklist).ttlock, false);
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...owner, body: { region: 'eu', username: 'acme-admin', password: 'acme-pass' } })).status, 200);

  g = await api.call('GET', '/api/onboarding/office?timeZone=Europe/London', owner);
  assert.equal(done(g.body.checklist).ttlock, true);
  assert.equal(done(g.body.checklist).doors, false);
  const p = g.body.plan;
  assert.deepEqual(p.sites.map(s => [s.name, s.doors, s.timezone]), [['Acme HQ', 6, 'Europe/London'], ['Acme Branch', 2, 'Europe/London'], ['Main office', 1, 'Europe/London']]);
  assert.deepEqual(p.doorGroups.map(d => [d.name, d.lockIds, d.sensitive]), [
    ['Entrances (Acme HQ)', [7001, 7002], false], ['Offices (Acme HQ)', [7003, 7004], false], ['Facilities (Acme HQ)', [7005], false], ['Secure rooms (Acme HQ)', [7006], true],
    ['Entrances (Acme Branch)', [7101], false], ['Offices (Acme Branch)', [7102], false],
    ['Facilities (Main office)', [7201], false],
  ]);
  assert.ok(!p.assignments.some(a => a.doorGroupKey.endsWith(':secure')), 'nobody gets the secure rooms by default');
  assert.match(p.notes.join(' '), /Comms Room → "Secure rooms", marked sensitive/);
  assert.match(p.notes.join(' '), /Main office: no door looks like an entrance/);

  assert.equal((await api.call('POST', '/api/onboarding/office', { ...owner, body: {} })).status, 400, 'time zone required');
  assert.equal((await api.call('POST', '/api/onboarding/office', { ...owner, body: { timeZone: 'Europe/London', officeHours: { days: [9], from: '07:00', to: '19:00' } } })).status, 400);
  const r = await api.call('POST', '/api/onboarding/office', { ...owner, body: { timeZone: 'Europe/London', officeHours: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.created, { sites: 3, doorGroups: 7, schedules: 2, userGroups: 6, assignments: 10 });
  assert.equal(done(r.body.checklist).doors, true);
  assert.equal(done(r.body.checklist).rules, true);
  assert.equal(done(r.body.checklist).sensitive, true);
  const audit = (await api.call('GET', '/api/audit?action=onboarding.office', owner)).body.log;
  assert.match(audit[0].detail, /3 sites, 7 doorGroups, 2 schedules, 6 userGroups, 10 assignments \(tz Europe\/London\)/);

  // The rules work: a Staff member opens the front door on a weekday at 10:00, not at 20:00, never the comms room.
  const ug = (await api.call('GET', '/api/userGroups', owner)).body.userGroups;
  const staff = ug.find(x => x.name === 'Staff (Acme HQ)');
  const cleaners = ug.find(x => x.name === 'Cleaners (Acme HQ)');
  const u = (await api.call('POST', '/api/users', { ...owner, body: { name: 'Pat Staff', groupIds: [staff.id] } })).body.item;
  const c = (await api.call('POST', '/api/users', { ...owner, body: { name: 'Cleo Cleaner', groupIds: [cleaners.id] } })).body.item;
  // A Tuesday a few weeks out, in London.
  const tue = (() => { const d = new Date(Date.now() + 21 * 864e5); while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const ev = async (userId, lockId, hm) => (await api.call('POST', '/api/evaluate', { ...owner, body: { userId, lockId, localTime: `${tue}T${hm}` } })).body.result.allowed;
  assert.equal(await ev(u.id, 7001, '10:00'), true);
  assert.equal(await ev(u.id, 7004, '10:00'), true, 'kitchen');
  assert.equal(await ev(u.id, 7001, '19:30'), false, 'custom office hours 08–18');
  assert.equal(await ev(u.id, 7006, '10:00'), false, 'comms room');
  assert.equal(await ev(u.id, 7005, '10:00'), false, 'cleaners cupboard');
  assert.equal(await ev(c.id, 7005, '19:00'), true);
  assert.equal(await ev(c.id, 7001, '10:00'), false, 'cleaners only in cleaning hours');
  assert.equal(await ev(c.id, 7101, '19:00'), false, 'other site');

  const again = await api.call('POST', '/api/onboarding/office', { ...owner, body: { timeZone: 'Europe/London' } });
  assert.equal(again.status, 200);
  assert.match(again.body.message, /Nothing to do/);
  assert.equal((await api.call('GET', '/api/doorGroups', owner)).body.doorGroups.length, 7);
});

test('office setup is owner-only and never puts an already sensitive door in an open group', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS: JSON.stringify([{ id: 'op_m', name: 'M', role: 'r_manager', tokenSha256: require('../audit-core').sha256Hex('m-token') }]), RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  assert.equal((await api.call('GET', '/api/onboarding/office', { token: 'm-token' })).status, 403);
  assert.equal((await api.call('POST', '/api/onboarding/office', { token: 'm-token', body: { timeZone: 'Europe/London' } })).status, 403);
  // Demo tenant: every door is already grouped (and the server room could be sensitive): nothing touched.
  const r = await api.call('POST', '/api/onboarding/office', { token: 'owner-token', body: { timeZone: 'Europe/London' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.alreadyGrouped.length, 7);
  assert.equal(r.body.plan.doorGroups.length, 0);
});
