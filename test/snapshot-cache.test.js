// Snapshot cache (store/snapshot-cache.js + migrations/0011): a cached read
// must always equal a fresh full read, whoever wrote to the database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { nodeSqliteAdapter, migrateNode } = require('../store/sqlite-node');
const { createStore } = require('../store/repo');
const { seedTenant } = require('../store/bootstrap');
const seed = require('../data/acl.json');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const T = 't_default';

async function setup({ file = ':memory:', cache = {}, seedIt = true } = {}) {
  const sql = nodeSqliteAdapter(file);
  migrateNode(sql, MIGRATIONS);
  const store = createStore(sql, { snapshotCache: { guard: false, ...cache } });
  if (seedIt) await seedTenant(store, T, { data: seed });
  // Reference: same database, no cache — what every read used to return.
  const plain = createStore(sql, { snapshotCache: { maxRows: 0 } });
  return { sql, store, plain };
}
// Cached items are frozen, uncached ones are not: compare as plain JSON.
const same = async (store, plain, tenantId = T) =>
  assert.deepEqual(JSON.parse(JSON.stringify(await store.tenant(tenantId).snapshot())), JSON.parse(JSON.stringify(await plain.tenant(tenantId).snapshot())));

test('repeat reads hit the cache; a write is applied as a patch, not a reload', async () => {
  const { store, plain } = await setup();
  const t = store.tenant(T);
  await t.snapshot();
  const s0 = store.cacheStats();
  await t.snapshot(); await t.snapshot();
  const s1 = store.cacheStats();
  assert.equal(s1.loads, s0.loads, 'no reload without writes');
  assert.equal(s1.hits, s0.hits + 2);

  await t.unit().insert('users', { id: 'u_new', name: 'New Person', groupIds: ['ug_staff'] }).audit('users.create', 'u_new', 'test').commit();
  await t.unit().update('users', 'u1', { suspended: true }).audit('users.suspend', 'u1', 'test').commit();
  const snap = await t.snapshot();
  const s2 = store.cacheStats();
  assert.equal(s2.loads, s1.loads, 'writes are patched in');
  assert.equal(s2.patches, s1.patches + 1, 'both writes in one patch');
  assert.equal(snap.users.find(u => u.id === 'u1').suspended, true);
  assert.equal(snap.users.find(u => u.id === 'u1').suspendedBy, 'operator', 'derived fields recomputed on patch');
  assert.equal(snap.users.at(-1).id, 'u_new');
  await t.snapshot();
  assert.equal(store.cacheStats().patches, s2.patches, 'after a patch the next read is a plain hit (label = last applied version)');
  await same(store, plain);
});

test('writes that bypass the app (raw SQL, other tables, deletes) are still seen — triggers, not discipline', async () => {
  const { sql, store, plain } = await setup();
  const t = store.tenant(T);
  await t.snapshot();
  await sql.batch([
    { sql: "UPDATE users SET name = 'Renamed by SQL' WHERE tenant_id = ? AND id = 'u2'", params: [T] },
    { sql: "UPDATE users SET directory_status = 'inactive' WHERE tenant_id = ? AND id = 'u3'", params: [T] },
    { sql: "DELETE FROM holidays WHERE tenant_id = ?", params: [T] },
    { sql: "UPDATE door_groups SET lock_ids = '[9001]' WHERE tenant_id = ? AND id = 'dg_ops'", params: [T] },
  ]);
  const snap = await t.snapshot();
  assert.equal(snap.users.find(u => u.id === 'u2').name, 'Renamed by SQL');
  assert.equal(snap.users.find(u => u.id === 'u3').suspendedBy, 'directory');
  assert.equal(snap.holidays.length, 0);
  assert.deepEqual(snap.doorGroups.find(g => g.id === 'dg_ops').lockIds, [9001]);
  await same(store, plain);
  // Settings are not versioned (json_set side writes) — they are read fresh every time.
  await sql.batch([{ sql: "UPDATE tenants SET settings = json_set(settings, '$.probe', 'x') WHERE id = ?", params: [T] }]);
  assert.equal((await t.snapshot()).settings.probe, 'x');
});

test('two processes on one database (Worker isolates, DO): a write through one is seen by the other', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessx-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.sqlite');
  const a = await setup({ file });
  const bSql = nodeSqliteAdapter(file);
  const b = createStore(bSql, { snapshotCache: { guard: false } });
  const before = await b.tenant(T).snapshot();
  assert.equal(before.users.find(u => u.id === 'u2').suspended, false);
  await a.store.tenant(T).unit().update('users', 'u2', { suspended: true }).audit('users.suspend', 'u2', 'test').commit();
  const after = await b.tenant(T).snapshot();
  assert.equal(after.users.find(u => u.id === 'u2').suspended, true, 'suspension visible to the other process on its next read');
  assert.equal(b.cacheStats().patches, 1);
  await same(b, a.plain);
});

test('delete + re-insert and bulk changes keep full-load order (rowid)', async () => {
  const { sql, store, plain } = await setup();
  const t = store.tenant(T);
  await t.snapshot();
  await sql.batch([
    { sql: "DELETE FROM users WHERE tenant_id = ? AND id = 'u1'", params: [T] },
    { sql: "INSERT INTO users (tenant_id, id, name, group_ids, suspended) VALUES (?, 'u1', 'Back again', '[]', 0)", params: [T] },
    { sql: "DELETE FROM users WHERE tenant_id = ? AND id = 'u4'", params: [T] },
  ]);
  const stmts = [];
  for (let i = 0; i < 250; i++) stmts.push({ sql: 'INSERT INTO users (tenant_id, id, name, group_ids, suspended) VALUES (?, ?, ?, ?, 0)', params: [T, `bulk${i}`, `Bulk ${i}`, '[]'] });
  await sql.batch(stmts); // > 90 ids: several IN (...) chunks
  const snap = await t.snapshot();
  assert.equal(store.cacheStats().loads, 1, 'patched, not reloaded');
  assert.deepEqual(snap.users.map(u => u.id).slice(-252, -250), ['u5', 'u1']);
  assert.equal(snap.users.some(u => u.id === 'u4'), false);
  await same(store, plain);
});

test('a pruned log, too many changes, old entries and a restored database all fall back to a full reload', async () => {
  const { sql, store, plain } = await setup({ cache: { patchMax: 50 } });
  const t = store.tenant(T);
  await t.snapshot();
  // Pruned past our version.
  await t.unit().update('users', 'u1', { name: 'A' }).audit('x', 'y', 'test').commit();
  await t.unit().update('users', 'u1', { name: 'B' }).audit('x', 'y', 'test').commit();
  assert.ok(await t.pruneChanges(1) >= 1);
  let loads = store.cacheStats().loads;
  assert.equal((await t.snapshot()).users.find(u => u.id === 'u1').name, 'B');
  assert.equal(store.cacheStats().loads, loads + 1);
  // More than patchMax changes.
  const stmts = [];
  for (let i = 0; i < 60; i++) stmts.push({ sql: "UPDATE users SET name = ? WHERE tenant_id = ? AND id = 'u2'", params: [`n${i}`, T] });
  await sql.batch(stmts);
  loads = store.cacheStats().loads;
  assert.equal((await t.snapshot()).users.find(u => u.id === 'u2').name, 'n59');
  assert.equal(store.cacheStats().loads, loads + 1);
  // Restore: the database goes back to an older version (its later log rows are gone).
  const v = Number((await sql.first('SELECT data_version AS v FROM tenants WHERE id = ?', [T])).v);
  await sql.batch([
    { sql: 'DELETE FROM snapshot_changes WHERE tenant_id = ? AND version > ?', params: [T, v - 5] },
    { sql: 'UPDATE tenants SET data_version = ? WHERE id = ?', params: [v - 5, T] },
    { sql: "UPDATE users SET name = 'restored' WHERE tenant_id = ? AND id = 'u2'", params: [T] }, // → version v-4 again
  ]);
  const r = await t.snapshot();
  assert.equal(r.users.find(u => u.id === 'u2').name, 'restored');
  await same(store, plain);
  // Age limit: reload even if the version says nothing changed.
  let clock = Date.now();
  const aged = await setup({ cache: { maxAgeMs: 1000, now: () => clock } });
  await aged.store.tenant(T).snapshot();
  clock += 2000;
  await aged.store.tenant(T).snapshot();
  assert.equal(aged.store.cacheStats().loads, 2);
});

test('the restore check does not cost a reload in the normal race (older version read, newer cache)', async () => {
  const { createSnapshotCache } = require('../store/snapshot-cache');
  const { COLLECTIONS } = require('../store/repo');
  const { sql, store } = await setup();
  await store.tenant(T).unit().update('users', 'u1', { name: 'X' }).audit('x', 'y', 'test').commit();
  const v = Number((await sql.first('SELECT data_version AS v FROM tenants WHERE id = ?', [T])).v);
  const cache = createSnapshotCache({ sql, collections: COLLECTIONS, toItem: (n, r) => ({ id: r.id }) });
  await cache.read(T, v);                 // someone refreshed to v
  const cols = await cache.read(T, v - 1); // a request that read the tenant row just before
  assert.equal(cache.stats().loads, 1, 'served from cache, no reload');
  assert.equal(cache.stats().restores, 0);
  assert.ok(cols.users.items.length > 0);
});

test('shared items are read-only: frozen in production, throwing in guard mode; arrays are per call', async () => {
  const { store } = await setup();
  const a = await store.tenant(T).snapshot();
  assert.equal(Object.isFrozen(a.users[0]), true);
  assert.equal(Object.isFrozen(a.users[0].groupIds), true);
  assert.throws(() => a.users[0].groupIds.push('x'), TypeError);
  a.users.push({ id: 'scratch' }); // callers own their arrays
  assert.equal((await store.tenant(T).snapshot()).users.some(u => u.id === 'scratch'), false);

  const g = await setup({ cache: { guard: true } });
  const s = await g.store.tenant(T).snapshot();
  assert.throws(() => { s.users[0].name = 'x'; }, { name: 'SnapshotMutationError' });
  assert.throws(() => { delete s.doorGroups[0].lockIds; }, { name: 'SnapshotMutationError' });
  assert.throws(() => { s.schedules[0].windows[0].from = '00:00'; }, { name: 'SnapshotMutationError' });
  assert.throws(() => s.users[0].groupIds.push('x'), { name: 'SnapshotMutationError' });
  assert.deepEqual({ ...s.users[0], name: 'copy' }.name, 'copy', 'copying works');
  assert.equal(s.users[0], s.users[0], 'stable identity');
});

test('memory budget: tenants over it are served uncached; least recently used tenants are evicted', async () => {
  const { store } = await setup({ cache: { maxRows: 30 } });
  await store.createTenant('t_b', 'B');
  await store.tenant('t_b').unit().insert('sites', { id: 's1', name: 'One' }).audit('x', 'y', 'test').commit();
  const seedRows = Object.values(await store.tenant(T).snapshot()).filter(Array.isArray).reduce((n, a) => n + a.length, 0);
  assert.ok(seedRows > 30, `seed has ${seedRows} rows`);
  await store.tenant(T).snapshot();
  assert.equal(store.cacheStats().tenants, 0, 'too big for the budget: not kept');
  await store.tenant('t_b').snapshot(); await store.tenant('t_b').snapshot();
  assert.equal(store.cacheStats().tenants, 1);
  assert.ok(store.cacheStats().hits >= 1);
});

test('concurrent readers after a write share one refresh; interleaved writes stay consistent', async () => {
  const { store, plain } = await setup();
  const t = store.tenant(T);
  await t.snapshot();
  await t.unit().update('users', 'u1', { name: 'Once' }).audit('x', 'y', 'test').commit();
  const before = store.cacheStats();
  const snaps = await Promise.all(Array.from({ length: 20 }, () => t.snapshot()));
  assert.ok(snaps.every(s => s.users.find(u => u.id === 'u1').name === 'Once'));
  assert.equal(store.cacheStats().patches - before.patches, 1, 'single-flight');
  assert.equal(store.cacheStats().loads, before.loads);
  await Promise.all(Array.from({ length: 30 }, (_, i) => i % 3 === 0
    ? t.unit().update('users', 'u2', { name: `w${i}` }).audit('x', 'y', 'test').commit()
    : t.snapshot()));
  await same(store, plain);
});

test('a database without migration 0011 (deploy before migrate) is served uncached instead of failing', async () => {
  const sql = nodeSqliteAdapter(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessx-mig-'));
  for (const f of fs.readdirSync(MIGRATIONS).filter(f => f < '0011')) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  migrateNode(sql, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const store = createStore(sql, { snapshotCache: { guard: false } });
  await seedTenant(store, T, { data: seed });
  assert.equal((await store.tenant(T).snapshot()).users.length, seed.users.length);
  assert.equal((await store.tenant(T).snapshot()).users.length, seed.users.length);
  assert.equal(store.cacheStats().tenants, 0);
});

test('migrations stay safe for the D1 remote splitter (uppercase BEGIN, LF, no CASE in triggers, no trailing trigger)', () => {
  for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))) {
    const text = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    assert.equal(text.includes('\r'), false, `${f}: CRLF line endings`);
    const code = text.replace(/--[^\n]*/g, '');
    const triggers = code.match(/CREATE\s+TRIGGER[\s\S]*?\bEND\s*;/gi) || [];
    for (const tr of triggers) {
      assert.match(tr, /\bBEGIN\b/, `${f}: trigger body must use uppercase BEGIN`);
      assert.doesNotMatch(tr, /\bbegin\b/, `${f}: lowercase begin`);
      assert.doesNotMatch(tr, /\bCASE\b/i, `${f}: CASE inside a trigger body`);
    }
    if (triggers.length) {
      const statements = code.split(/;\s*(?=\n|$)/).map(s => s.trim()).filter(Boolean);
      assert.doesNotMatch(statements.at(-1), /^END$/i, `${f}: must not end with a trigger`);
    }
  }
  // Every snapshot table is versioned (a table added to COLLECTIONS without triggers would go stale).
  const { COLLECTIONS } = require('../store/repo');
  const sqlText = fs.readFileSync(path.join(MIGRATIONS, '0011_snapshot_versions.sql'), 'utf8');
  for (const { table } of Object.values(COLLECTIONS)) {
    for (const ev of ['INSERT', 'UPDATE', 'DELETE']) assert.match(sqlText, new RegExp(`AFTER ${ev} ON ${table}\\n`), `${table} ${ev} trigger`);
  }
});

test('through the API: guard on, reads hit the cache, a suspension denies at once, maintenance prunes the log', async t => {
  const { boot } = require('../support/boot');
  const api = await boot({ ADMIN_TOKEN: 'o' });
  t.after(api.close);
  const { store } = api.server;
  assert.equal(store.cacheStats().guard, true, 'boot() runs the API in guard mode');
  await api.call('GET', '/api/users', { token: 'o' });
  const h = store.cacheStats().hits;
  await api.call('GET', '/api/users', { token: 'o' });
  assert.ok(store.cacheStats().hits > h, 'second read is a cache hit');
  assert.equal((await api.call('POST', '/api/evaluate', { token: 'o', body: { userId: 'u2', lockId: 9002 } })).body.result.allowed, true);
  assert.equal((await api.call('POST', '/api/users/u2/suspend', { token: 'o' })).status, 200);
  assert.equal((await api.call('POST', '/api/evaluate', { token: 'o', body: { userId: 'u2', lockId: 9002 } })).body.result.allowed, false, 'no stale allow after suspension');
  // Maintenance keeps the newest 5000 change rows.
  const sql = store.sql;
  const stmts = [];
  for (let i = 0; i < 5100; i++) stmts.push({ sql: "UPDATE users SET name = ? WHERE tenant_id = 't_default' AND id = 'u3'", params: [`n${i}`] });
  await sql.batch(stmts);
  const out = (await api.server.api.maintenance()).find(r => r.tenantId === 't_default');
  assert.ok(out.changesPruned >= 100, JSON.stringify(out));
  assert.equal(Number((await sql.first("SELECT COUNT(*) AS n FROM snapshot_changes WHERE tenant_id = 't_default'")).n), 5000);
  assert.equal((await api.call('GET', '/api/users', { token: 'o' })).body.users.find(u => u.id === 'u3').name, 'n5099');
});
