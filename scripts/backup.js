#!/usr/bin/env node
/**
 * Backups you have actually restored (docs/12-GO-LIVE.md, "Backup and restore").
 *
 *   npm run backup -- node   [--data-dir DIR] [--out FILE]      # Node: consistent copy (VACUUM INTO)
 *   npm run backup -- d1     [--db NAME] [--local [--persist-to DIR]] [--out FILE]
 *                                                               # Cloudflare D1: wrangler d1 export (remote by default)
 *   npm run backup -- verify FILE.sqlite|FILE.sql [--secrets-key KEYS]
 *
 * `node` and `d1` verify the file right after writing it. Verifying = restoring
 * it into a scratch database, never touching the original:
 *   1. it loads, and SQLite's integrity and foreign-key checks pass;
 *   2. its schema is at the migration this code expects;
 *   3. every tenant's audit chain verifies (the same check as GET /api/audit/verify);
 *   4. every sealed secret was sealed with a key in SECRETS_KEY. A backup without
 *      the key that sealed its TTLock tokens and SSO secrets restores into a
 *      system where every tenant must reconnect.
 * Exit code 1 if any check fails.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.removeAllListeners('warning'); // node:sqlite is "experimental"
const { DatabaseSync } = require('node:sqlite');
const root = path.join(__dirname, '..');
const { nodeSqliteAdapter } = require(path.join(root, 'store', 'sqlite-node'));
const { createStore } = require(path.join(root, 'store', 'repo'));
const { keyIds } = require(path.join(root, 'secrets-core'));
const { SCHEMA_VERSION } = require(path.join(root, 'api-core'));

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');

let refCache = null;
function referenceSchema() {
  if (refCache) return refCache;
  const { migrateNode } = require(path.join(root, 'store', 'sqlite-node'));
  const db = new DatabaseSync(':memory:');
  migrateNode({ raw: db }, path.join(root, 'migrations'));
  refCache = new Set(db.prepare("SELECT type || ' ' || name AS o FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','d1_migrations') AND name NOT LIKE '_cf_%'").all().map(r => r.o));
  db.close();
  return refCache;
}

/** Restore FILE into a scratch database; return a report (never throws on bad data). */
async function verifyBackup(file, { secretsKey = process.env.SECRETS_KEY || '' } = {}) {
  const checks = [];
  const add = (ok, id, message) => checks.push({ ok, id, message });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessx-restore-'));
  const scratch = path.join(dir, 'restore.sqlite');
  try {
    if (/\.sql$/i.test(file)) {
      const db = new DatabaseSync(scratch);
      try { db.exec(fs.readFileSync(file, 'utf8')); add(true, 'load', `SQL dump loaded (${(fs.statSync(file).size / 1024).toFixed(0)} KiB)`); } catch (error) { add(false, 'load', `SQL dump does not load: ${error.message}`); return { ok: false, checks }; } finally { db.close(); }
    } else {
      fs.copyFileSync(file, scratch);
      add(true, 'load', `database file copied (${(fs.statSync(file).size / 1024).toFixed(0)} KiB)`);
    }
    const sql = nodeSqliteAdapter(scratch);
    try {
      const raw = sql.raw;
      const integrity = raw.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
      add(integrity.length === 1 && integrity[0] === 'ok', 'integrity', integrity.length === 1 && integrity[0] === 'ok' ? 'SQLite integrity check ok' : `integrity check: ${integrity.slice(0, 3).join('; ')}`);
      const fk = raw.prepare('PRAGMA foreign_key_check').all();
      add(fk.length === 0, 'foreign_keys', fk.length ? `${fk.length} row(s) point at missing parents (first: ${fk[0].table})` : 'no dangling foreign keys');

      const tables = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
      const migTable = ['d1_migrations', 'schema_migrations'].find(t => tables.has(t));
      const applied = migTable ? (raw.prepare(`SELECT name FROM ${migTable} ORDER BY name DESC LIMIT 1`).get() || {}).name : null;
      const at = applied ? String(applied).replace(/\.sql$/, '') : null;
      if (!at) add(false, 'schema', 'no migration table: not an AccessX database?');
      else if (at < SCHEMA_VERSION) add(true, 'schema', `schema at ${at}; this code expects ${SCHEMA_VERSION}: apply migrations after restoring`);
      else add(true, 'schema', `schema at ${at}`);

      // Same tables, indexes and triggers as a database built from migrations/
      // (the append-only audit triggers must survive the round trip).
      const ref = referenceSchema();
      const objectsOf = db => new Set(db.prepare("SELECT type || ' ' || name AS o FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','d1_migrations') AND name NOT LIKE '_cf_%'").all().map(r => r.o));
      const have = objectsOf(raw);
      const missing = [...ref].filter(o => !have.has(o));
      if (!missing.length) add(true, 'objects', `all ${ref.size} tables, indexes and triggers present`);
      else add(at && at < SCHEMA_VERSION, 'objects', `${missing.length} schema object(s) missing: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}`);

      if (!tables.has('tenants')) { add(false, 'tenants', 'no tenants table'); return { ok: false, checks }; }
      const store = createStore(sql, { snapshotCache: { maxRows: 0 } });
      const tenants = raw.prepare('SELECT id, name FROM tenants ORDER BY id').all();
      add(tenants.length > 0, 'tenants', `${tenants.length} tenant(s)`);
      const count = (table, tenantId) => (tables.has(table) ? raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tenantId).n : 0);
      const perTenant = [];
      for (const t of tenants) {
        const v = await store.tenant(t.id).auditVerify();
        perTenant.push({ id: t.id, name: t.name, users: count('users', t.id), credentials: count('credentials', t.id), visits: count('visits', t.id), audit: v.count, auditOk: v.ok });
        add(v.ok, `audit:${t.id}`, v.ok ? `${t.id}: audit chain intact (${v.count} entries, head ${v.head.seq})` : `${t.id}: audit chain BROKEN at ${v.brokenAt}: ${v.problem}`);
      }

      // Sealed secrets carry the id of the key that sealed them: v2.<kid>.<iv>.<ct>,
      // as a whole column or inside JSON (tenant settings, alert config).
      const used = new Map();
      const SEALED = /(?<![A-Za-z0-9+/=._-])v2\.([0-9a-f]{16})\.[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*/g;
      for (const table of tables) {
        if (table.startsWith('sqlite_') || table === migTable) continue;
        for (const col of raw.prepare(`PRAGMA table_info("${table}")`).all()) {
          if (!/TEXT|^$/i.test(col.type)) continue;
          for (const r of raw.prepare(`SELECT "${col.name}" AS v FROM "${table}" WHERE instr("${col.name}", 'v2.') > 0`).iterate()) {
            for (const m of String(r.v).matchAll(SEALED)) used.set(m[1], (used.get(m[1]) || 0) + 1);
          }
        }
      }
      const sealed = [...used.values()].reduce((a, b) => a + b, 0);
      if (!sealed) add(true, 'secrets', 'no sealed secrets in this backup');
      else if (!secretsKey) add(false, 'secrets', `${sealed} sealed secret(s); pass --secrets-key (or SECRETS_KEY) to check the key is still held`);
      else {
        let have = [];
        try { have = await keyIds(secretsKey); } catch (error) { add(false, 'secrets', `SECRETS_KEY unusable: ${error.message}`); }
        if (have.length) {
          const missing = [...used.keys()].filter(k => !have.includes(k));
          add(!missing.length, 'secrets', missing.length
            ? `${missing.map(k => used.get(k)).reduce((a, b) => a + b, 0)} sealed secret(s) need key id(s) ${missing.join(', ')}, which SECRETS_KEY does not hold`
            : `${sealed} sealed secret(s), all under keys in SECRETS_KEY`);
        }
      }
      return { ok: checks.every(c => c.ok), checks, tenants: perTenant, schema: at };
    } finally { sql.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function printReport(file, r) {
  console.log(`\nRestore test of ${file}`);
  for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.message}`);
  if (r.tenants && r.tenants.length) {
    console.log('\n  tenant                       users  creds  visits  audit');
    for (const t of r.tenants) console.log(`  ${String(t.id).padEnd(28)} ${String(t.users).padStart(5)}  ${String(t.credentials).padStart(5)}  ${String(t.visits).padStart(6)}  ${String(t.audit).padStart(5)}${t.auditOk ? '' : ' BROKEN'}`);
  }
  console.log(`\n${r.ok ? '✓ restorable' : '✗ NOT restorable'}\n`);
}

/** Node deployment: VACUUM INTO writes a consistent, compacted copy while the server runs. */
function backupNode({ dataDir, out }) {
  const src = path.join(dataDir, 'accessx.sqlite');
  if (!fs.existsSync(src)) throw new Error(`no database at ${src}`);
  if (fs.existsSync(out)) throw new Error(`${out} exists`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const db = new DatabaseSync(src, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(out); } finally { db.close(); }
  return out;
}

/** Cloudflare D1: `wrangler d1 export` (schema + data as SQL). */
function backupD1({ db, local, persistTo, out }) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (local && persistTo) {
    // `wrangler d1 export` has no --persist-to: copy the local D1 file (drills only).
    const dir = path.join(persistTo, 'v3', 'd1', 'miniflare-D1DatabaseObject');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite') : [];
    if (files.length !== 1) throw new Error(`expected one local D1 database in ${dir}, found ${files.length}`);
    const target = out.replace(/\.sql$/i, '.sqlite');
    const src = new DatabaseSync(path.join(dir, files[0]), { readOnly: true });
    try { src.prepare('VACUUM INTO ?').run(target); } finally { src.close(); }
    return target;
  }
  const a = ['wrangler', 'd1', 'export', db, local ? '--local' : '--remote', '--output', out];
  if (local && persistTo) a.push('--persist-to', persistTo);
  execFileSync('npx', a, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 });
  return out;
}

async function main() {
  const mode = args[0];
  const secretsKey = opt('--secrets-key') || process.env.SECRETS_KEY || '';
  let file;
  if (mode === 'verify') {
    file = args[1];
    if (!file) throw new Error('usage: backup verify FILE');
  } else if (mode === 'node') {
    file = backupNode({ dataDir: opt('--data-dir') || process.env.DATA_DIR || path.join(root, 'data', 'runtime'), out: opt('--out') || path.join(root, 'backups', `accessx-${stamp()}.sqlite`) });
    console.log(`wrote ${file}`);
  } else if (mode === 'd1') {
    file = backupD1({ db: opt('--db') || 'accessx-demo', local: flag('--local'), persistTo: opt('--persist-to'), out: opt('--out') || path.join(root, 'backups', `d1-${stamp()}.sql`) });
    console.log(`wrote ${file}`);
  } else {
    console.error('usage: npm run backup -- node|d1|verify …   (see scripts/backup.js)');
    process.exit(2);
  }
  const r = await verifyBackup(file, { secretsKey });
  if (flag('--json')) console.log(JSON.stringify(r, null, 2)); else printReport(file, r);
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(2); });
module.exports = { verifyBackup, backupNode };
