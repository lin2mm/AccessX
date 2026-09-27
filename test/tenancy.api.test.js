const assert = require('node:assert/strict');
const test = require('node:test');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');

const OPS = JSON.stringify([
  { id: 'op_gym', name: 'Gym manager', role: 'r_manager', siteIds: ['site_gym'], tokenSha256: sha256Hex('gym-token') },
]);
const env = { ADMIN_TOKEN: 'owner-token', OPERATORS: OPS, PLATFORM_TOKEN: 'platform-token' };
const owner = { token: 'owner-token' };
const gym = { token: 'gym-token' };

test('tenants are isolated end to end', async t => {
  const api = await boot(env);
  t.after(api.close);
  const created = await api.call('POST', '/api/tenants', { token: 'platform-token', body: { name: 'Acme Gyms' } });
  assert.equal(created.status, 200);
  const acme = { token: created.body.owner.token };
  assert.match(acme.token, /^ax_[0-9a-f]{48}$/);

  // Acme starts empty (default roles only) and sees none of the default tenant's data.
  for (const coll of ['users', 'sites', 'doorGroups', 'credentials']) {
    assert.deepEqual((await api.call('GET', `/api/${coll}`, acme)).body[coll], [], coll);
  }
  assert.equal((await api.call('GET', '/api/roles', acme)).body.roles.length, 5); // incl. r_provisioner (SCIM)
  assert.equal((await api.call('DELETE', '/api/users/u1', acme)).status, 404);
  assert.equal((await api.call('POST', '/api/evaluate', acme, { body: { userId: 'u1', lockId: 9001 } })).body.result.allowed, false);

  // Same id in both tenants: separate rows.
  const site = await api.call('POST', '/api/sites', { ...acme, body: { name: 'Acme HQ', timezone: 'Australia/Sydney' } });
  assert.equal(site.status, 200);
  assert.equal((await api.call('GET', '/api/sites', owner)).body.sites.some(s => s.name === 'Acme HQ'), false);

  // Separate audit chains.
  const acmeAudit = (await api.call('GET', '/api/audit', acme)).body.log;
  assert.ok(acmeAudit.every(e => !/u1|lock 90/.test(e.detail)));
  assert.equal(acmeAudit.at(-1).seq, 1);
  assert.equal((await api.call('GET', '/api/audit/verify', acme)).body.verification.ok, true);
  assert.equal((await api.call('GET', '/api/audit/verify', owner)).body.verification.ok, true);

  // Tenant tokens cannot use platform routes.
  assert.equal((await api.call('GET', '/api/tenants', acme)).status, 401);
  assert.equal((await api.call('GET', '/api/tenants', { token: 'platform-token' })).body.tenants.length, 2);
});

test('operators live in the database: issue, scope, no escalation, instant revoke', async t => {
  const api = await boot(env);
  t.after(api.close);
  const made = await api.call('POST', '/api/operators', { ...owner, body: { name: 'Store manager', role: 'r_manager', siteIds: ['site_store'] } });
  assert.equal(made.status, 200);
  const store = { token: made.body.token };
  assert.deepEqual((await api.call('GET', '/api/doors', store)).body.doors.map(d => d.lockId), [9201]);

  // Listing never exposes tokens or hashes; the audit entry neither.
  const listed = await api.call('GET', '/api/operators', owner);
  assert.ok(listed.body.operators.some(o => o.id === made.body.operator.id));
  assert.doesNotMatch(JSON.stringify(listed.body), /tokenSha256|ax_[0-9a-f]{10}/);
  assert.equal(listed.body.bootstrap.find(o => o.id === 'op_gym').source, 'env (bootstrap)');
  const audit = await api.call('GET', '/api/audit?action=operator.create', owner);
  assert.doesNotMatch(JSON.stringify(audit.body.log), new RegExp(made.body.token));

  // Only role.manage may create operators; a manager cannot mint an owner.
  assert.equal((await api.call('POST', '/api/operators', { ...gym, body: { name: 'x', role: 'r_owner' } })).status, 403);
  await api.call('POST', '/api/roles', { ...owner, body: { name: 'Team lead', perms: ['role.manage', 'door.read'] } });
  const lead = (await api.call('GET', '/api/roles', owner)).body.roles.find(r => r.name === 'Team lead');
  const leadOp = await api.call('POST', '/api/operators', { ...owner, body: { name: 'Lead', role: lead.id, siteIds: ['site_gym'] } });
  const leadTok = { token: leadOp.body.token };
  const escalate = await api.call('POST', '/api/operators', { ...leadTok, body: { name: 'x', role: 'r_manager', siteIds: ['site_gym'] } });
  assert.equal(escalate.status, 403);
  assert.match(escalate.body.detail, /permissions you do not hold/);
  const wider = await api.call('POST', '/api/operators', { ...leadTok, body: { name: 'x', role: lead.id, siteIds: ['site_river'] } });
  assert.equal(wider.status, 403);
  assert.equal((await api.call('POST', '/api/operators', { ...leadTok, body: { name: 'x', role: lead.id, siteIds: ['site_gym'] } })).status, 200);

  // Revocation is immediate; you cannot revoke yourself.
  assert.equal((await api.call('DELETE', `/api/operators/${leadOp.body.operator.id}`, leadTok)).status, 409);
  assert.equal((await api.call('DELETE', `/api/operators/${made.body.operator.id}`, owner)).status, 200);
  assert.equal((await api.call('GET', '/api/doors', store)).status, 401);
});

test('site managers manage only people entirely within their sites', async t => {
  const api = await boot(env);
  t.after(api.close);
  // Someone with a gym membership AND an office job.
  const both = await api.call('POST', '/api/users', { ...owner, body: { name: 'Dual Person', groupIds: ['ug_member', 'ug_staff'] } });
  const id = both.body.item.id;

  const seen = (await api.call('GET', '/api/users', gym)).body.users.map(u => u.id);
  assert.deepEqual(seen.sort(), [id, 'u4'].sort());
  assert.equal((await api.call('POST', `/api/users/${id}/suspend`, gym)).status, 403);
  assert.equal((await api.call('DELETE', `/api/users/${id}`, gym)).status, 403);
  assert.equal((await api.call('POST', '/api/users/u1/suspend', gym)).status, 404);
  assert.equal((await api.call('POST', '/api/users/u4/suspend', gym)).status, 200);

  // Creating: every group must be in scope, and there must be one.
  assert.equal((await api.call('POST', '/api/users', { ...gym, body: { name: 'No group' } })).status, 403);
  assert.equal((await api.call('POST', '/api/users', { ...gym, body: { name: 'Mixed', groupIds: ['ug_member', 'ug_it'] } })).status, 403);
  assert.equal((await api.call('POST', '/api/users', { ...gym, body: { name: 'New member', groupIds: ['ug_member'] } })).status, 200);

  // Groups/rules are filtered to scope.
  assert.deepEqual((await api.call('GET', '/api/userGroups', gym)).body.userGroups.map(g => g.id).sort(), ['ug_gymstaff', 'ug_member']);
  assert.ok((await api.call('GET', '/api/assignments', gym)).body.assignments.every(a => ['as7', 'as8'].includes(a.id)));

  // Audit: a scoped operator sees only their own actions.
  const log = await api.call('GET', '/api/audit', gym);
  assert.equal(log.body.scopedToActor, true);
  assert.ok(log.body.log.length >= 2);
  assert.ok(log.body.log.every(e => e.actor === 'op_gym'));
});

test('removing a person revokes their codes; offline locks go to pending removal until confirmed on site', async t => {
  const api = await boot(env);
  t.after(api.close);
  const online = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9001, userId: 'u3', acknowledgeScheduleGap: true } });
  const offline = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9004, userId: 'u3', acknowledgeScheduleGap: true } });
  assert.equal(online.status, 200);
  assert.equal(offline.status, 200);

  const del = await api.call('DELETE', '/api/users/u3', owner);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.reconcile, { revoked: 1, expired: 0, pendingRemoval: 1, failed: 0, overdue: 0, escalated: 0 });

  const creds = (await api.call('GET', '/api/credentials', owner)).body.credentials;
  const status = id => creds.find(c => c.id === id).status;
  assert.equal(status(online.body.credential.id), 'revoked');
  assert.equal(status(offline.body.credential.id), 'pending_removal');

  // It stays visible as work to do …
  const compiled = await api.call('GET', '/api/compile', owner);
  assert.deepEqual(compiled.body.pendingRemoval.map(c => c.id), [offline.body.credential.id]);
  // … until someone confirms removal at the lock.
  const confirm = await api.call('POST', `/api/credentials/${offline.body.credential.id}/confirm-removed`, owner);
  assert.equal(confirm.body.credential.status, 'revoked');
  assert.equal((await api.call('POST', `/api/credentials/${offline.body.credential.id}/confirm-removed`, owner)).status, 409);

  const actions = (await api.call('GET', '/api/audit?limit=10', owner)).body.log.map(e => e.action);
  for (const a of ['credential.removed_on_site', 'credential.pending_removal', 'credential.auto_revoke', 'users.delete']) assert.ok(actions.includes(a), a);

  // Manual reconcile: nothing left to do; dry run changes nothing.
  const dry = await api.call('POST', '/api/reconcile', { ...owner, body: { dryRun: true } });
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.plan.actions.length, 0);
});

test('GDPR: audit holds ids only; export returns everything; delete erases the person', async t => {
  const api = await boot(env);
  t.after(api.close);
  const u = await api.call('POST', '/api/users', { ...owner, body: { name: 'Erin Erasable', email: 'erin@example.org', groupIds: ['ug_it'] } });
  const id = u.body.item.id;
  await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: id } });

  const exp = await api.call('GET', `/api/users/${id}/export`, owner);
  assert.equal(exp.body.user.email, 'erin@example.org');
  assert.equal(exp.body.credentials.length, 1);
  assert.ok(exp.body.auditEvents.some(e => e.action === 'users.create'));
  assert.ok(exp.body.auditEvents.some(e => e.action === 'passcode.create'));

  assert.equal((await api.call('DELETE', `/api/users/${id}`, owner)).status, 200);
  const { sql } = api.server.store;
  const leaks = await sql.all("SELECT seq, detail FROM audit_events WHERE detail LIKE '%Erin%' OR detail LIKE '%erin@%'");
  assert.deepEqual(leaks, []);
  assert.deepEqual(await sql.all('SELECT id FROM users WHERE id = ?', [id]), []);
  assert.equal((await api.call('GET', '/api/audit/verify', owner)).body.verification.ok, true);
});

test('concurrent writes: no lost updates, chain stays intact', async t => {
  const api = await boot(env);
  t.after(api.close);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    api.call('POST', '/api/holidays', { ...owner, body: { date: `2027-01-${String(i + 1).padStart(2, '0')}`, name: `H${i}` } })));
  assert.ok(results.every(r => r.status === 200));
  const names = (await api.call('GET', '/api/holidays', owner)).body.holidays.map(x => x.name);
  for (let i = 0; i < 20; i++) assert.ok(names.includes(`H${i}`));
  assert.equal((await api.call('GET', '/api/audit/verify', owner)).body.verification.ok, true);
});
