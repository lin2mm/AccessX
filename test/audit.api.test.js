const assert = require('node:assert/strict');
const test = require('node:test');
const { boot } = require('../support/boot');

test('audit log is append-only, chained, and migrates the legacy log', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const owner = { token: 'owner-token' };

  const first = await api.call('GET', '/api/audit', owner);
  assert.deepEqual(first.body.log.slice(0, 2).map(e => e.action), ['tenant.seeded', 'audit.migrated']);

  for (let i = 0; i < 3; i++) await api.call('POST', '/api/doors/9001/unlock', { ...owner, body: { reason: 'test run' } });
  const verify = await api.call('GET', '/api/audit/verify', owner);
  assert.equal(verify.body.verification.ok, true);
  const head = verify.body.verification.head;
  assert.ok(head.seq >= 18);

  // nothing is ever dropped: pagination reaches seq 1
  const oldest = await api.call('GET', `/api/audit?before=3&limit=10`, owner);
  assert.deepEqual(oldest.body.log.map(e => e.seq), [2, 1]);

  // Through SQL the history cannot be changed at all (triggers).
  const { sql } = api.server.store;
  await assert.rejects(sql.batch([{ sql: "UPDATE audit_events SET actor = 'x' WHERE seq = 6", params: [] }]), /append-only/);

  // An attacker with the raw database file can drop the triggers —
  // the hash chain still pinpoints the edited entry.
  sql.raw.exec("DROP TRIGGER audit_events_no_update; UPDATE audit_events SET actor = 'someone-else' WHERE tenant_id = 't_default' AND seq = 6");
  const broken = await api.call('GET', '/api/audit/verify', owner);
  assert.equal(broken.body.verification.ok, false);
  assert.equal(broken.body.verification.brokenAt, 6);
});

test('upgrade: legacy DATA_DIR files are imported once, chain carried over, files retired', async t => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const auditCore = require('../audit-core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessx-legacy-'));
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'acl.json'), 'utf8'));
  const legacy = { ...seed, userGroups: seed.userGroups.map(({ siteId, ...g }) => g), users: [...seed.users, { id: 'u_old', name: 'Legacy Larry', groupIds: ['ug_member'], suspended: false }] };
  delete legacy.auditLog;
  const chain = auditCore.seal(null, [auditCore.pending('seed', 'old install'), auditCore.pending('users.create', 'u_old')]);
  fs.writeFileSync(path.join(dir, 'acl.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), chain.map(e => JSON.stringify(e)).join('\n') + '\n');

  const api = await boot({ ADMIN_TOKEN: 'owner-token', DATA_DIR: dir });
  t.after(async () => { await api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const owner = { token: 'owner-token' };
  assert.ok((await api.call('GET', '/api/users', owner)).body.users.some(u => u.id === 'u_old'));
  const log = (await api.call('GET', '/api/audit?limit=10', owner)).body.log;
  assert.equal(log.at(-1).hash, chain[0].hash); // original hashes survive
  assert.deepEqual(log.slice(0, 2).map(e => e.action), ['userGroups.site_inferred', 'tenant.seeded']);
  assert.equal((await api.call('GET', '/api/audit/verify', owner)).body.verification.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'acl.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'acl.json.migrated')), true);
  // ids inferred → the gym group now belongs to the gym site
  assert.equal((await api.call('GET', '/api/userGroups', owner)).body.userGroups.find(g => g.id === 'ug_member').siteId, 'site_gym');
});
