// R18 access review, passcode sweep, bulk invitations, retention overview (docs/24-ACCESS-REVIEW.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');
const { demoFixture } = require('../support/fake-ttlock');
const review = require('../review-core');

const OWNER = { token: 'owner-token' };
const RIVER = { token: 'river-token' };
const GYM = { token: 'gym-token' };
const AUDIT = { token: 'audit-token' };
const DESK = { token: 'desk-token' };
const OPERATORS = JSON.stringify([
  { id: 'op_river', name: 'Riverside manager', role: 'r_manager', siteIds: ['site_river'], tokenSha256: sha256Hex('river-token') },
  { id: 'op_gym', name: 'Gym manager', role: 'r_manager', siteIds: ['site_gym'], tokenSha256: sha256Hex('gym-token') },
  { id: 'op_audit', name: 'Auditor', role: 'r_view', siteIds: [], tokenSha256: sha256Hex('audit-token') },
  { id: 'op_desk', name: 'Reception', role: 'r_front_desk', siteIds: ['site_river'], tokenSha256: sha256Hex('desk-token') },
]);

async function mailbox(t) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { got.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"e"}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, got };
}
async function setup(t, env = {}) {
  const mail = await mailbox(t);
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, RECONCILE_INTERVAL_MIN: '0', SECRETS_KEY: Buffer.alloc(32, 9).toString('base64'),
    EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'desk@accessx.example', EMAIL_API_BASE: mail.base, PUBLIC_URL: 'https://doors.example', ...env });
  t.after(api.close);
  return { api, mail, sql: api.server.store.sql.raw };
}
const byName = (items, name, siteId) => items.find(i => i.name === name && (siteId === undefined || i.siteId === siteId));

test('review-core: lines per site and person, operators; removal plan sees other-site groups and directory groups', () => {
  const snap = {
    sites: [{ id: 's1' }, { id: 's2' }],
    doorGroups: [{ id: 'd1', siteId: 's1', lockIds: [1, 2] }, { id: 'd2', siteId: 's2', lockIds: [3] }],
    userGroups: [{ id: 'g1', name: 'S1 staff', siteId: 's1' }, { id: 'g2', name: 'S2 staff', siteId: 's2' }, { id: 'gx', name: 'Everywhere', siteId: 's2' }],
    assignments: [{ userGroupId: 'g1', doorGroupId: 'd1' }, { userGroupId: 'g2', doorGroupId: 'd2' }, { userGroupId: 'gx', doorGroupId: 'd1' }],
    schedules: [],
    users: [
      { id: 'a', groupIds: ['g1'] },
      { id: 'b', groupIds: ['g1', 'gx'] },
      { id: 'c', groupIds: ['g1'], suspended: true },
      { id: 'd', groupIds: ['g1'], validTo: '2020-01-01T00:00:00Z' },
      { id: 'e', groupIds: [] },
    ],
    credentials: [{ id: 'k1', userId: 'e', lockId: 3, siteId: 's2', status: 'active' }, { id: 'k2', userId: 'a', lockId: 1, status: 'revoked' }, { id: 'k3', userId: 'e', lockId: 3, visitId: 'v', status: 'active' }],
    directoryGroups: [{ displayName: 'Entra: S1 staff', userGroupId: 'g1', memberIds: ['b'] }],
  };
  const items = review.buildItems(snap, [{ id: 'op1', role: 'r_owner' }, { id: 'op2', role: 'r_view', revokedAt: '2026-01-01' }]);
  assert.deepEqual(items.map(i => `${i.kind}:${i.siteId}:${i.subjectId}`), ['door:s1:a', 'door:s1:b', 'door:s2:e', 'admin:null:op1']);
  assert.deepEqual(items[1].detail, { lockIds: [1, 2], groupIds: ['g1', 'gx'], codes: 0, source: null });
  assert.equal(items[2].detail.codes, 1, 'an own active code counts; a visitor code does not');

  const plan = review.planRemoval(snap, 'b', 's1');
  // gx is a group of site s2 that grants s1 doors: leaving s1's groups is not enough.
  assert.deepEqual([plan.leave, plan.keepGroups, plan.stillLockIds, plan.stillGroups, plan.directory], [['g1'], ['gx'], [1, 2], ['Everywhere'], ['Entra: S1 staff']]);
  assert.equal(review.planRemoval(snap, 'zz', 's1').ok, false);
  assert.deepEqual(review.summarise([{ kind: 'door', decision: 'keep' }, { kind: 'admin', decision: null }, { kind: 'door', decision: 'remove' }]),
    { total: 3, kept: 1, removed: 1, undecided: 1, door: 2, admin: 1 });
  assert.equal(review.validateSettings({ everyDays: 45 }).ok, false);
  assert.equal(review.validateSettings({ dueDays: 2 }).ok, false);
  assert.deepEqual(review.settingsOf({ accessReview: { everyDays: 90, dueDays: 10 } }), { everyDays: 90, dueDays: 10 });
});

test('access review: scoped reviewers, keep / remove acts at once, never your own line, close and evidence', async t => {
  const { api, mail } = await setup(t);
  // An administrator to review, and a second owner (who may not decide their own line).
  const temp = await api.call('POST', '/api/operators', { ...OWNER, body: { name: 'Temp admin', role: 'r_view', email: 'temp@acme.co.uk' } });
  assert.equal(temp.status, 200, JSON.stringify(temp.body));
  const owner2 = await api.call('POST', '/api/operators', { ...OWNER, body: { name: 'Second owner', role: 'r_owner', email: 'owner2@acme.co.uk' } });
  const OWNER2 = { token: owner2.body.token };
  // CleanCo holds a code on the warehouse door (gateway).
  const code = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9003, userId: 'u3', acknowledgeScheduleGap: true } });
  assert.equal(code.status, 200, JSON.stringify(code.body));

  assert.equal((await api.call('POST', '/api/access-reviews', { ...RIVER, body: {} })).status, 403, 'only owners start reviews');
  assert.equal((await api.call('PUT', '/api/access-reviews/settings', { ...OWNER, body: { everyDays: 45 } })).status, 400);
  const start = await api.call('POST', '/api/access-reviews', { ...OWNER, body: { dueDays: 7 } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.deepEqual(start.body.review.summary, { total: 6, kept: 0, removed: 0, undecided: 6, door: 4, admin: 2 });
  assert.equal((await api.call('POST', '/api/access-reviews', { ...OWNER, body: {} })).status, 409, 'one open review at a time');
  // Owners with an email are told about the admin lines; env operators have no address.
  assert.deepEqual(mail.got.map(m => m.to[0]).sort(), ['owner2@acme.co.uk']);
  assert.match(mail.got[0].subject, /please confirm who still needs access/);

  const all = (await api.call('GET', '/api/access-reviews', OWNER)).body.open;
  assert.deepEqual(all.items.map(i => `${i.kind}:${i.name}`).sort(), ['admin:Second owner', 'admin:Temp admin', 'door:CleanCo Ltd', 'door:Dev Patel', 'door:Sarah Kelly', 'door:Tom Nguyen']);
  const clean = byName(all.items, 'CleanCo Ltd');
  assert.deepEqual([clean.siteName, clean.groups, clean.codes], ['Riverside Office', ['Cleaning Contractor'], 1]);
  assert.deepEqual(clean.doors.sort(), ['Cleaner Cupboard', 'Main Entrance', 'Warehouse Side Door']);

  // The gym manager sees and decides only gym lines; no administrator lines.
  const gymView = (await api.call('GET', '/api/access-reviews', GYM)).body.open;
  assert.deepEqual(gymView.items.map(i => i.name), ['Tom Nguyen']);
  assert.equal(gymView.items[0].canDecide, true);
  const rid = all.id;
  const decide = (who, item, decision, note) => api.call('POST', `/api/access-reviews/${rid}/items/${item.id}`, { ...who, body: { decision, note } });
  assert.equal((await decide(GYM, clean, 'remove')).status, 404, 'another site\'s line is not found');
  assert.equal((await decide(RIVER, byName(all.items, 'Temp admin'), 'remove')).status, 404, 'administrator lines need all-site scope');
  assert.equal((await decide(AUDIT, clean, 'keep')).status, 403, 'the auditor can look, not decide');
  assert.equal((await decide(OWNER2, byName(all.items, 'Second owner'), 'keep')).status, 403, 'nobody confirms their own access');
  assert.equal((await decide(RIVER, clean, 'maybe')).status, 400);

  assert.equal((await decide(RIVER, byName(all.items, 'Sarah Kelly'), 'keep', 'still here')).status, 200);
  const rm = await decide(RIVER, clean, 'remove', 'contract ended');
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.match(rm.body.item.outcome, /left Cleaning Contractor; 1 code\(s\) deleted from the locks/);
  const u3 = (await api.call('GET', '/api/users', OWNER)).body.users.find(u => u.id === 'u3');
  assert.deepEqual(u3.groupIds, []);
  const cred = (await api.call('GET', '/api/credentials', OWNER)).body.credentials.find(c => c.id === code.body.credential.id);
  assert.deepEqual([cred.status, cred.revokeReason], ['revoked', `access review ${rid}`]);
  assert.equal((await api.call('GET', '/api/users/u3/doors', OWNER)).body.doors.length, 0);
  assert.equal((await decide(RIVER, clean, 'keep')).status, 409, 'a removal is final');

  // An administrator line: removing revokes the operator and ends their sessions.
  assert.equal((await api.call('GET', '/api/doors', { token: temp.body.token })).status, 200);
  const rmAdmin = await decide(OWNER, byName(all.items, 'Temp admin'), 'remove');
  assert.equal(rmAdmin.body.item.outcome, 'administrator access revoked, sessions ended');
  assert.equal((await api.call('GET', '/api/doors', { token: temp.body.token })).status, 401);

  assert.equal((await api.call('POST', `/api/access-reviews/${rid}/close`, { ...OWNER, body: { removeUndecided: true } })).status, 409, 'bulk removal only after the due date');
  const closed = await api.call('POST', `/api/access-reviews/${rid}/close`, { ...OWNER, body: { note: 'Q3 review' } });
  assert.deepEqual(closed.body.summary, { total: 6, kept: 1, removed: 2, undecided: 3, door: 4, admin: 2 });
  assert.equal((await decide(RIVER, byName(all.items, 'Dev Patel'), 'keep')).status, 404, 'closed');
  const after = (await api.call('GET', '/api/access-reviews', OWNER)).body;
  assert.equal(after.open, null);
  assert.equal(after.history[0].closeNote, 'Q3 review');

  const ev = (await api.call('GET', '/api/reports/evidence?days=30', OWNER)).body.evidence;
  assert.equal(ev.accessReview.reviews.length, 1);
  assert.deepEqual([ev.accessReview.reviews[0].summary.removed, ev.accessReview.reviews[0].onTime], [2, true]);
  assert.ok(ev.controls.find(c => c.control === 'A.5.18').evidence.includes('accessReview'));
  const log = (await api.call('GET', '/api/audit?limit=200', OWNER)).body.log.map(e => e.action);
  for (const a of ['review.start', 'review.keep', 'review.remove', 'operator.revoke', 'review.close']) assert.ok(log.includes(a), a);
});

test('access review: reminders, overdue notice to owners, removal of unconfirmed lines, quarterly auto-start', async t => {
  const { api, mail, sql } = await setup(t);
  await api.call('POST', '/api/operators', { ...OWNER, body: { name: 'River boss', role: 'r_manager', siteIds: ['site_river'], email: 'boss@acme.co.uk' } });
  await api.call('POST', '/api/operators', { ...OWNER, body: { name: 'Owner Two', role: 'r_owner', email: 'o2@acme.co.uk' } });
  await api.call('POST', '/api/operators', { ...OWNER, body: { name: 'Gym boss', role: 'r_manager', siteIds: ['site_gym'], email: 'gymboss@acme.co.uk' } });
  const maintain = () => api.server.api.maintainOne('t_default');

  assert.equal((await api.call('PUT', '/api/access-reviews/settings', { ...OWNER, body: { everyDays: 90, dueDays: 10 } })).status, 200);
  const first = await maintain();
  assert.ok(first.accessReview && first.accessReview.started, JSON.stringify(first));
  const rev = sql.prepare("SELECT * FROM access_reviews WHERE status = 'open'").get();
  assert.equal(rev.started_by, 'system');
  // River boss decides river lines; the second owner decides everything.
  const starts = mail.got.filter(m => /please confirm/.test(m.subject)).map(m => m.to[0]).sort();
  assert.deepEqual(starts, ['boss@acme.co.uk', 'gymboss@acme.co.uk', 'o2@acme.co.uk']);
  // Each is told about the lines they can decide: the gym boss only Tom (gym), the office boss
  // the three office people, the owner 4 door lines + 3 administrators minus their own line.
  const count = to => Number(mail.got.find(m => m.to[0] === to).text.match(/(\d+) line\(s\) are waiting for you/)[1]);
  assert.deepEqual([count('gymboss@acme.co.uk'), count('boss@acme.co.uk'), count('o2@acme.co.uk')], [1, 3, 6]);
  assert.equal((await maintain()).accessReview, undefined, 'nothing more to do yet');

  // Two days before the due date: one reminder, once.
  sql.prepare('UPDATE access_reviews SET due_at = ? WHERE id = ?').run(new Date(Date.now() + 2 * 864e5).toISOString(), rev.id);
  assert.ok((await maintain()).accessReview.reminded >= 1);
  assert.equal((await maintain()).accessReview, undefined);
  assert.ok(mail.got.some(m => /^Reminder: access review due/.test(m.subject)));

  // Overdue: the owners hear about it, once.
  sql.prepare('UPDATE access_reviews SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 864e5).toISOString(), rev.id);
  await maintain();
  const overdue = mail.got.filter(m => /overdue/.test(m.subject));
  assert.deepEqual(overdue.map(m => m.to[0]), ['o2@acme.co.uk']);

  // After the due date the owner may remove everyone nobody confirmed (door lines only).
  const open = (await api.call('GET', '/api/access-reviews', OWNER)).body.open;
  assert.equal(open.overdue, true);
  const tom = byName(open.items, 'Tom Nguyen');
  await api.call('POST', `/api/access-reviews/${rev.id}/items/${tom.id}`, { ...OWNER, body: { decision: 'keep' } });
  const close = await api.call('POST', `/api/access-reviews/${rev.id}/close`, { ...OWNER, body: { removeUndecided: true } });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  assert.equal(close.body.removed, 3, 'Sarah, Dev and CleanCo were never confirmed');
  const users = (await api.call('GET', '/api/users', OWNER)).body.users;
  assert.deepEqual(users.filter(u => ['u1', 'u2', 'u3', 'u4'].includes(u.id)).map(u => `${u.id}:${u.groupIds.join('+')}`), ['u1:', 'u2:', 'u3:', 'u4:ug_member']);
  const items = sql.prepare('SELECT * FROM access_review_items WHERE review_id = ? AND decision = ?').all(rev.id, 'remove');
  assert.ok(items.every(i => i.note === 'not confirmed by the due date'));

  // Quarterly: not again until 90 days after the last start.
  assert.equal((await maintain()).accessReview, undefined);
  sql.prepare('UPDATE access_reviews SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 91 * 864e5).toISOString(), rev.id);
  assert.ok((await maintain()).accessReview.started);
});

test('passcode sweep (demo locks): finds codes set outside AccessX, removes them, never a live registered code', async t => {
  const { api } = await setup(t);
  const code = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9001, userId: 'u1', acknowledgeScheduleGap: true } });
  assert.equal(code.status, 200, JSON.stringify(code.body));
  const ref = code.body.credential.vendorRef;

  const sw = await api.call('POST', '/api/passcode-sweep', { ...OWNER, body: {} });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.deepEqual(sw.body.summary, { registered: 1, should_be_gone: 0, unknown: 2, expired_unknown: 1, missing: 0, unreadable: 0 });
  const main = sw.body.locks.find(l => l.lockId === 9001);
  assert.deepEqual(main.codes.map(c => `${c.class}:${c.ref}`).sort(), [`registered:${ref}`, 'unknown:demo-501']);
  assert.equal(main.codes.find(c => c.ref === ref).holder, 'Sarah Kelly');
  assert.equal(JSON.stringify(sw.body).includes('keyboardPwd'), false, 'never the digits');

  const live = await api.call('POST', '/api/passcode-sweep/remove', { ...OWNER, body: { lockId: 9001, refs: [ref, 'demo-501'] } });
  assert.deepEqual(live.body.results.map(r => r.ok), [false, true]);
  assert.match(live.body.results[0].error, /live AccessX code/);
  assert.equal((await api.call('POST', '/api/passcode-sweep/remove', { ...OWNER, body: { lockId: 9004, refs: ['x'] } })).status, 409, 'no gateway: on site');
  const again = await api.call('POST', '/api/passcode-sweep', { ...OWNER, body: { siteId: 'site_river' } });
  assert.deepEqual(again.body.locks.find(l => l.lockId === 9001).codes.map(c => c.ref), [ref]);

  // A gym manager sweeps only gym doors and cannot touch Riverside's locks.
  const gym = await api.call('POST', '/api/passcode-sweep', { ...GYM, body: {} });
  assert.deepEqual(gym.body.locks.map(l => l.lockId).sort(), [9101, 9102]);
  assert.equal((await api.call('POST', '/api/passcode-sweep', { ...GYM, body: { siteId: 'site_river' } })).status, 403);
  assert.equal((await api.call('POST', '/api/passcode-sweep/remove', { ...GYM, body: { lockId: 9003, refs: ['demo-502'] } })).status, 403);
  assert.equal((await api.call('POST', '/api/passcode-sweep', { ...AUDIT, body: {} })).status, 403, 'auditor cannot sweep');
  assert.equal((await api.call('POST', '/api/passcode-sweep', { ...OWNER, body: { siteId: 'site_nowhere' } })).status, 404, 'unknown site');
  const hist = (await api.call('GET', '/api/passcode-sweep', GYM)).body.sweeps;
  assert.equal(hist.length, 0, 'all-site sweeps are not shown to a site manager');
  assert.equal((await api.call('GET', '/api/passcode-sweep', OWNER)).body.sweeps.length, 3);
  const log = (await api.call('GET', '/api/audit?action=passcodes.sweep_remove', OWNER)).body.log;
  assert.match(log[0].detail, /lock 9001 refs demo-501 \(not in AccessX 1, revoked in AccessX 0\)/);
  assert.equal(log[0].detail.includes('cleaner'), false, 'code names stay out of the audit chain');
});

test('passcode sweep (TTLock): a revoked code still on the lock, a code missing from the lock, and a stranger', async t => {
  const cloud = demoFixture();
  const base = await cloud.listen(0);
  t.after(() => cloud.close());
  const { api } = await setup(t, { TTLOCK_API_BASE: base, TTLOCK_CLIENT_ID: 'platform-app', TTLOCK_CLIENT_SECRET: 'platform-secret', PLATFORM_TOKEN: 'platform-token' });
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...OWNER, body: { region: 'eu', username: 'riverside-admin', password: 'river-pass-1' } })).status, 200);
  const a = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9001, userId: 'u1', acknowledgeScheduleGap: true } });
  const b = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9001, userId: 'u2', acknowledgeScheduleGap: true } });
  const c = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9003, userId: 'u2', acknowledgeScheduleGap: true } });
  for (const r of [a, b, c]) assert.equal(r.status, 200, JSON.stringify(r.body));
  // Restored backup / failed delete: AccessX says revoked, the lock still has it.
  api.server.store.sql.raw.prepare("UPDATE credentials SET status = 'revoked' WHERE id = ?").run(b.body.credential.id);
  // Someone deleted a code in the TTLock app: AccessX still thinks it is live.
  const lock9003 = cloud.state.locks[9003];
  lock9003.cloud.delete(Number(c.body.credential.vendorRef)); lock9003.device.delete(Number(c.body.credential.vendorRef));
  // And a code made in the TTLock app.
  cloud.state.locks[9001].cloud.set(777, { keyboardPwdId: 777, keyboardPwd: '424242', keyboardPwdName: 'Installer', keyboardPwdType: 2, startDate: Date.now() - 864e5, endDate: 0, senderUsername: 'riverside-admin', sendDate: Date.now() - 864e5 });

  const sw = await api.call('POST', '/api/passcode-sweep', { ...OWNER, body: {} });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.deepEqual(sw.body.summary, { registered: 1, should_be_gone: 1, unknown: 1, expired_unknown: 0, missing: 1, unreadable: 0 });
  const l1 = sw.body.locks.find(l => l.lockId === 9001);
  const stranger = l1.codes.find(x => x.ref === '777');
  assert.deepEqual([stranger.class, stranger.type, stranger.name, stranger.endAt], ['unknown', 'permanent', 'Installer', null]);
  assert.equal(JSON.stringify(sw.body).includes('424242'), false, 'never the digits');
  assert.deepEqual(sw.body.locks.find(l => l.lockId === 9003).missing.map(m => m.credentialId), [c.body.credential.id]);

  const rm = await api.call('POST', '/api/passcode-sweep/remove', { ...OWNER, body: { lockId: 9001, refs: ['777', b.body.credential.vendorRef] } });
  assert.deepEqual(rm.body.results.map(r => r.ok), [true, true]);
  assert.equal(cloud.onDevice(9001, 777), false, 'deleted on the device (deleteType 2)');
  assert.equal(cloud.onDevice(9001, b.body.credential.vendorRef), false);

  const fg = await api.call('POST', '/api/passcode-sweep/forget', { ...OWNER, body: { credentialIds: [c.body.credential.id] } });
  assert.deepEqual(fg.body.results, [{ credentialId: c.body.credential.id, ok: true }]);
  const creds = (await api.call('GET', '/api/credentials', OWNER)).body.credentials;
  assert.deepEqual([creds.find(x => x.id === c.body.credential.id).status, creds.find(x => x.id === c.body.credential.id).revokeReason], ['revoked', 'not on the lock (passcode sweep)']);
  // Forgetting a code that IS on the lock changes nothing.
  const still = await api.call('POST', '/api/passcode-sweep/forget', { ...OWNER, body: { credentialIds: [a.body.credential.id] } });
  assert.equal(still.body.results[0].ok, false);
  const clean = await api.call('POST', '/api/passcode-sweep', { ...OWNER, body: {} });
  assert.deepEqual(clean.body.summary, { registered: 1, should_be_gone: 0, unknown: 0, expired_unknown: 0, missing: 0, unreadable: 0 });
});

test('bulk invitations: one list, same doors and times; bad shared settings send nothing; no links returned', async t => {
  const { api, mail } = await setup(t);
  const d = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const common = { hostUserId: 'u1', lockIds: [9001], startLocal: `${d}T09:00`, endLocal: `${d}T17:00` };
  const bad = await api.call('POST', '/api/visit-invites/bulk', { ...DESK, body: { ...common, lockIds: [9101], rows: [{ email: 'a@guest.example' }] } });
  assert.equal(bad.status, 403, 'a door outside the desk\'s site fails the whole list');
  assert.equal(mail.got.length, 0);
  const ok = await api.call('POST', '/api/visit-invites/bulk', { ...DESK, body: { ...common, rows: [{ email: 'A@guest.example' }, { email: 'b@guest.example' }, { email: 'a@guest.example' }, { email: 'not-an-email' }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.sent, ok.body.failed], [2, 2]);
  assert.deepEqual(ok.body.results.map(r => r.error || 'ok'), ['ok', 'ok', 'twice in the list', 'visitorEmail is not a valid address']);
  assert.equal(JSON.stringify(ok.body).includes('/invite#'), false);
  assert.deepEqual(mail.got.map(m => m.to[0]).sort(), ['a@guest.example', 'b@guest.example']);
  assert.equal((await api.call('POST', '/api/visit-invites/bulk', { ...DESK, body: { ...common, rows: Array.from({ length: 101 }, (_, i) => ({ email: `g${i}@x.example` })) } })).status, 400);
  assert.equal((await api.call('POST', '/api/visit-invites/bulk', { ...AUDIT, body: { ...common, rows: [{ email: 'c@guest.example' }] } })).status, 403);
});

test('retention overview: what is kept and where to change it', async t => {
  const { api } = await setup(t);
  const r = await api.call('GET', '/api/retention', AUDIT);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map(i => i.id), ['audit', 'visitors', 'battery', 'signups', 'reviews', 'people']);
  assert.equal(r.body.items.find(i => i.id === 'visitors').days, 30);
  assert.equal(r.body.canChangeAudit, false);
  assert.equal((await api.call('GET', '/api/retention', OWNER)).body.canChangeAudit, true);
  assert.equal((await api.call('GET', '/api/retention', DESK)).status, 403);
});
