const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { nodeSqliteAdapter, migrateNode } = require('./sqlite-node');
const { createStore } = require('./repo');
const { seedTenant } = require('./bootstrap');
const auditCore = require('../audit-core');
const seed = require('../data/acl.json');

function fresh() {
  const sql = nodeSqliteAdapter(':memory:');
  migrateNode(sql, path.join(__dirname, '..', 'migrations'));
  return createStore(sql);
}

test('seeding imports the seed data and legacy audit once', async () => {
  const store = fresh();
  const first = await seedTenant(store, 't_default', { data: seed, legacyAudit: seed.auditLog });
  assert.equal(first.seeded, true);
  assert.equal((await seedTenant(store, 't_default', { data: seed })).seeded, false); // idempotent
  const snap = await store.tenant('t_default').snapshot();
  assert.equal(snap.sites.length, 3);
  assert.equal(snap.sites[0].timezone, 'Europe/London');
  assert.deepEqual(snap.doorGroups.find(d => d.id === 'dg_ops').lockIds, [9003, 9004]);
  assert.equal(typeof snap.users[0].suspended, 'boolean');
  assert.equal(snap.userGroups.find(g => g.id === 'ug_member').siteId, 'site_gym');
  const verify = await store.tenant('t_default').auditVerify();
  assert.equal(verify.ok, true);
  const recent = await store.tenant('t_default').auditRecent({ limit: 2 });
  assert.deepEqual(recent.map(e => e.action), ['tenant.seeded', 'audit.migrated']);
});

test('a verified legacy chain is imported with its original hashes', async () => {
  const store = fresh();
  const sealed = auditCore.seal(null, [auditCore.pending('a', '1'), auditCore.pending('b', '2')]);
  await seedTenant(store, 't_default', { data: seed, sealedAudit: sealed });
  const t = store.tenant('t_default');
  const all = await t.auditRecent({ limit: 10 });
  assert.equal(all.at(-1).hash, sealed[0].hash);
  assert.equal((await t.auditVerify()).ok, true);

  const store2 = fresh();
  const forged = sealed.map(e => ({ ...e }));
  forged[1].detail = 'forged';
  await seedTenant(store2, 't_default', { data: seed, sealedAudit: forged });
  const recent = await store2.tenant('t_default').auditRecent({ limit: 10 });
  assert.equal(recent.at(-1).action, 'audit.import_rejected');
});

test('tenants are isolated at the storage layer', async () => {
  const store = fresh();
  await seedTenant(store, 't_default', { data: seed });
  await store.createTenant('t_other', 'Other');
  await seedTenant(store, 't_other', { data: { sites: [{ id: 'site_river', name: 'Same id, different tenant' }] } });

  const a = store.tenant('t_default');
  const other = store.tenant('t_other');
  assert.equal((await other.snapshot()).users.length, 0);
  assert.equal((await other.snapshot()).sites[0].name, 'Same id, different tenant');

  // Deleting "site_river" in t_other must not touch t_default's row.
  await other.unit().remove('sites', 'site_river').audit('sites.delete', 'site_river').commit();
  assert.equal((await a.snapshot()).sites.some(s => s.id === 'site_river'), true);
  assert.equal((await other.snapshot()).sites.length, 0);

  // Each tenant has its own chain starting at seq 1.
  assert.equal((await other.auditRecent({ limit: 100 })).at(-1).seq, 1);
  assert.equal((await other.auditVerify()).ok, true);
  assert.equal((await a.auditVerify()).ok, true);
});

test('row-level writes: concurrent edits to different rows both survive', async () => {
  const store = fresh();
  await seedTenant(store, 't_default', { data: seed });
  const t = store.tenant('t_default');
  const u1 = t.unit().update('users', 'u1', { suspended: true }).audit('users.suspend', 'u1');
  const u2 = t.unit().update('users', 'u2', { email: 'dev@new.example' }).audit('users.update', 'u2');
  await Promise.all([u1.commit(), u2.commit()]); // both read the same audit head
  const snap = await t.snapshot();
  assert.equal(snap.users.find(u => u.id === 'u1').suspended, true);
  assert.equal(snap.users.find(u => u.id === 'u2').email, 'dev@new.example');
  assert.equal((await t.auditVerify()).ok, true); // retry re-sealed; chain intact
});

test('the database refuses edits to audit history', async () => {
  const store = fresh();
  await seedTenant(store, 't_default', { data: seed });
  await assert.rejects(store.sql.batch([{ sql: "UPDATE audit_events SET actor = 'x' WHERE seq = 1", params: [] }]), /append-only/);
  await assert.rejects(store.sql.batch([{ sql: 'DELETE FROM audit_events', params: [] }]), /append-only/);
});
