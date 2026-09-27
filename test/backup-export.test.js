// R20: weekly D1 -> R2 export (backup-export-core.js). The copy must pass the
// same restore test as a manual backup (scripts/backup.js verify).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { boot } = require('../support/boot');
const { nodeSqliteAdapter } = require('../store/sqlite-node');
const { verifyBackup } = require('../scripts/backup');
const { exportBackup, maybeExport, listBackups, dumpSql, literal } = require('../backup-export-core');

/** Just enough of R2: put/get/delete, list with prefix + paging (2 per page, to exercise the cursor). */
function fakeBucket() {
  const objects = new Map();
  let clock = 0;
  return {
    objects,
    setClock(ms) { clock = ms; },
    async put(key, body, { customMetadata = {} } = {}) { objects.set(key, { key, body: Buffer.from(body), size: body.length, uploaded: new Date(clock), customMetadata }); },
    async delete(key) { objects.delete(key); },
    async list({ prefix = '', cursor } = {}) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + 2).map(k => { const o = objects.get(k); return { key: k, size: o.size, uploaded: o.uploaded, customMetadata: o.customMetadata }; });
      return { objects: page, truncated: start + 2 < keys.length, cursor: String(start + 2) };
    },
  };
}

const OWNER = 'owner-token-for-r2-export-test-0123456789';

test('R2 export: the uploaded .sql.gz restores and passes every verify check, awkward text intact', async () => {
  const secretsKey = crypto.randomBytes(32).toString('base64');
  const s = await boot({ ADMIN_TOKEN: OWNER, SECRETS_KEY: secretsKey, ALLOW_HTTP_WEBHOOKS: '1' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessx-r2-'));
  try {
    assert.equal((await s.call('PUT', '/api/alerts', { token: OWNER, body: { webhookUrl: 'https://hooks.acme-offices.com/x' } })).status, 200); // a sealed secret
    const odd = "Siobhán O'Brien \"Shiv\" 第二行 😀 ; DROP TABLE users; --"; // (newlines are refused at input)
    assert.equal((await s.call('POST', '/api/users', { token: OWNER, body: { name: odd, email: 'shiv@example.com' } })).status, 200);

    const sql = nodeSqliteAdapter(path.join(s.dataDir, 'accessx.sqlite'));
    const bucket = fakeBucket();
    const now = Date.parse('2026-10-04T17:05:00Z');
    bucket.setClock(now);
    const r = await exportBackup({ sql, bucket, now });
    assert.equal(r.key, 'd1/accessx-2026-10-04T17-05-00Z.sql.gz');
    assert.ok(r.tables > 10 && r.rows > 20, JSON.stringify(r));
    assert.ok(r.gzipBytes < r.sqlBytes / 3, 'compressed');
    const listed = await listBackups(bucket);
    assert.equal(listed[0].rows, String(r.rows));
    assert.match(listed[0].schema, /^\d{4}_/);

    const file = path.join(dir, 'export.sql.gz');
    fs.writeFileSync(file, bucket.objects.get(r.key).body);
    const v = await verifyBackup(file, { secretsKey });
    assert.equal(v.ok, true, JSON.stringify(v.checks));
    assert.ok(v.checks.some(c => c.id === 'audit:t_default' && c.ok));
    assert.match(v.checks.find(c => c.id === 'secrets').message, /1 sealed secret\(s\), all under keys/);
    const restored = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(restored);
    const names = db.prepare('SELECT name FROM users').all().map(u => u.name);
    assert.ok(names.includes(odd), 'quotes, CJK, emoji and SQL-looking text survive');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, (await sql.all('SELECT COUNT(*) AS n FROM audit_events'))[0].n);
    db.close();

    // A copy that was changed after export fails verify (the chain is re-checked).
    const tampered = restored.replace(/(INSERT INTO "audit_events" \([^)]*\) VALUES\([^\n]*?)'owner'/, "$1'mallory'");
    assert.notEqual(tampered, restored, 'test setup: found an audit row to change');
    const bad = path.join(dir, 'tampered.sql.gz');
    fs.writeFileSync(bad, zlib.gzipSync(tampered));
    assert.equal((await verifyBackup(bad, { secretsKey })).ok, false);
    sql.close();
  } finally { await s.close(); }
});

test('R2 export: weekly in the backup hour only, newest 3 kept, paging through the listing', async () => {
  const s = await boot({ ADMIN_TOKEN: OWNER });
  try {
    const sql = nodeSqliteAdapter(path.join(s.dataDir, 'accessx.sqlite'));
    const bucket = fakeBucket();
    let t = Date.parse('2026-10-04T12:00:00Z');
    const tick = async () => { bucket.setClock(t); return maybeExport({ sql, bucket, now: t, keep: 3, hourUtc: 17 }); };
    assert.equal((await tick()).skipped, 'not the backup hour');
    t = Date.parse('2026-10-04T17:00:00Z');
    assert.ok((await tick()).key, 'first copy');
    t += 15 * 60e3;
    assert.equal((await tick()).skipped, 'recent copy exists'); // next cron tick, same hour
    for (let week = 1; week <= 4; week++) { t = Date.parse('2026-10-04T17:00:00Z') + week * 7 * 24 * 3600e3; assert.ok((await tick()).key, `week ${week}`); }
    const keys = (await listBackups(bucket)).map(o => o.key);
    assert.deepEqual(keys, ['d1/accessx-2026-11-01T17-00-00Z.sql.gz', 'd1/accessx-2026-10-25T17-00-00Z.sql.gz', 'd1/accessx-2026-10-18T17-00-00Z.sql.gz']);
    sql.close();
  } finally { await s.close(); }
});

test('R2 export: literals and paging', async () => {
  assert.equal(literal(null), 'NULL');
  assert.equal(literal("it's"), "'it''s'");
  assert.equal(literal(Uint8Array.from([0, 255])), "X'00ff'");
  assert.equal(literal(Number.NaN), 'NULL');
  // 1,203 rows with 500 per page: 3 pages, every row once.
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = raw.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < 1203; i++) ins.run(`v${i}`);
  let queries = 0;
  const sql = { async all(q, p = []) { queries++; return raw.prepare(q).all(...p).map(r => ({ ...r })); } };
  const d = await dumpSql(sql);
  assert.equal(d.rows, 1203);
  assert.equal((d.text.match(/^INSERT INTO "t"/gm) || []).length, 1203);
  assert.equal(queries, 1 + 3);
});

test('doctor: a running Worker without BACKUPS is warned; USAGE_METER in production is warned', () => {
  const { checkConfig } = require('../doctor-core');
  const find = (f, id) => f.find(x => x.id === id);
  const db = { prepare() {} };
  assert.equal(find(checkConfig({ DB: db }, { runtime: 'worker' }), 'BACKUPS').level, 'warn');
  assert.equal(find(checkConfig({ DB: db, BACKUPS: { put() {} } }, { runtime: 'worker' }), 'BACKUPS').level, 'ok');
  assert.equal(find(checkConfig({}, { runtime: 'worker' }), 'BACKUPS'), undefined, 'the CLI cannot see bindings: no finding');
  assert.equal(find(checkConfig({ USAGE_METER: '1' }, { runtime: 'worker' }), 'USAGE_METER').level, 'warn');
  assert.equal(find(checkConfig({ USAGE_METER: '1' }, { runtime: 'worker', production: false }), 'USAGE_METER'), undefined);
});
