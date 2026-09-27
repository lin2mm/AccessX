// R14 go-live: configuration doctor, /api/healthz, open-reads guard, backups
// (docs/12-GO-LIVE.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { boot } = require('../support/boot');
const { checkConfig, checkWrangler, resolveOpenReads, summary } = require('../doctor-core');
const { SCHEMA_VERSION } = require('../api-core');
const { verifyBackup, backupNode } = require('../scripts/backup');

const key = () => crypto.randomBytes(32).toString('base64');
const strong = () => crypto.randomBytes(32).toString('base64url');
const byId = (findings, id) => findings.filter(f => f.id === id);

function productionEnv(extra = {}) {
  return {
    ADMIN_TOKEN: strong(), SECRETS_KEY: key(), PUBLIC_URL: 'https://doors.acme-offices.com',
    SECURITY_CONTACT: 'mailto:security@acme-offices.com', TTLOCK_CLIENT_ID: 'cid', TTLOCK_CLIENT_SECRET: 'csecret',
    TTLOCK_NOTIFY_SECRET: strong(), EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_live_x', EMAIL_FROM: 'Doors <doors@acme-offices.com>',
    ...extra,
  };
}

test('doctor: the demo settings are not production-ready, and it says why', () => {
  const f = checkConfig({ ADMIN_TOKEN: 'owner-token', AUTH_OPEN_READS: '1', SECRETS_KEY: key(), PUBLIC_URL: 'http://127.0.0.1:8787', ALLOW_HTTP_WEBHOOKS: '1' }, { runtime: 'worker' });
  const errors = f.filter(x => x.level === 'error').map(x => x.id);
  for (const id of ['ADMIN_TOKEN', 'AUTH_OPEN_READS', 'PUBLIC_URL', 'SECURITY_CONTACT', 'ALLOW_HTTP_WEBHOOKS']) assert.ok(errors.includes(id), `${id} should be an error`);
  assert.equal(summary(f).ready, false);
  // Development mode: the same problems are warnings, nothing blocks.
  assert.equal(summary(checkConfig({ ADMIN_TOKEN: 'owner-token', SECRETS_KEY: key() }, { production: false })).ready, true);
});

test('doctor: a complete production config is ready; findings never contain secret values', () => {
  const env = productionEnv({ AUDIT_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: 'dd', x: 'xx' }) });
  const f = checkConfig(env, { runtime: 'worker' });
  assert.deepEqual(f.filter(x => x.level === 'error'), []);
  assert.equal(summary(f).ready, true);
  const text = JSON.stringify(f);
  for (const k of ['ADMIN_TOKEN', 'SECRETS_KEY', 'TTLOCK_CLIENT_SECRET', 'TTLOCK_NOTIFY_SECRET', 'EMAIL_API_KEY', 'AUDIT_SIGNING_KEY']) {
    assert.ok(!text.includes(env[k]), `${k} value leaked into findings`);
  }
});

test('doctor: each misconfiguration is caught', () => {
  const errorFor = (extra, id) => {
    const f = checkConfig(productionEnv(extra));
    assert.ok(byId(f, id).some(x => x.level === 'error'), `${JSON.stringify(extra)} → expected error on ${id}: ${JSON.stringify(byId(f, id))}`);
  };
  errorFor({ SECRETS_KEY: crypto.randomBytes(16).toString('base64') }, 'SECRETS_KEY');
  errorFor({ SECRETS_KEY: `${key()},not-base64!` }, 'SECRETS_KEY');
  errorFor({ SECRETS_KEY: '' }, 'SECRETS_KEY');
  errorFor({ PUBLIC_URL: 'https://doors.acme-offices.com/app' }, 'PUBLIC_URL');
  errorFor({ PUBLIC_URL: 'https://doors.example.com' }, 'PUBLIC_URL');
  errorFor({ SECURITY_CONTACT: 'security@acme.com' }, 'SECURITY_CONTACT');
  errorFor({ TTLOCK_NOTIFY_SECRET: 'short' }, 'TTLOCK_NOTIFY_SECRET');
  errorFor({ EMAIL_FROM: '' }, 'EMAIL_PROVIDER');
  errorFor({ EMAIL_PROVIDER: 'sendgrid' }, 'EMAIL_PROVIDER');
  errorFor({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1' }, 'SMS_PROVIDER');
  errorFor({ OPERATORS: '[{"id":"x","role":"r_owner","token":"plain"}]' }, 'OPERATORS');
  errorFor({ AUDIT_SIGNING_KEY: '{"kty":"OKP"}' }, 'AUDIT_SIGNING_KEY');
  errorFor({ MOCK_IDP: '1' }, 'MOCK_IDP');
  errorFor({ BILLING_ENABLED: '1' }, 'BILLING_ENABLED');
  errorFor({ ADMIN_TOKEN: '', OPERATORS: '', PLATFORM_TOKEN: '' }, 'ADMIN_TOKEN');
  // Warnings, not errors: works, but somebody should know.
  const w = checkConfig(productionEnv({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', SMS_FROM: '+100' }));
  assert.equal(byId(w, 'SMS_MONTHLY_CAP')[0].level, 'warn');
});

test('doctor: Worker secrets known only by name are reported as set, their values left to the runtime check', () => {
  const present = new Set(['ADMIN_TOKEN', 'SECRETS_KEY', 'PUBLIC_URL', 'SECURITY_CONTACT', 'TTLOCK_CLIENT_ID', 'TTLOCK_CLIENT_SECRET', 'TTLOCK_NOTIFY_SECRET']);
  const f = checkConfig({ AUTH_OPEN_READS: '0' }, { runtime: 'worker', present });
  assert.deepEqual(f.filter(x => x.level === 'error'), []);
  assert.equal(byId(f, 'SECRETS_KEY')[0].level, 'info');
});

test('open reads: explicit opt-in only, and refused when real locks are configured', () => {
  assert.deepEqual(resolveOpenReads({}), { open: false, refused: false }); // Worker default is now closed
  assert.deepEqual(resolveOpenReads({ AUTH_OPEN_READS: '1' }), { open: true, refused: false }); // public demo
  assert.deepEqual(resolveOpenReads({ AUTH_OPEN_READS: '1', TTLOCK_CLIENT_ID: 'cid' }), { open: false, refused: true });
  assert.deepEqual(resolveOpenReads({}, { demoDefault: true }), { open: true, refused: false }); // Node demo without TTLock
  assert.deepEqual(resolveOpenReads({ AUTH_OPEN_READS: '0' }, { demoDefault: true }), { open: false, refused: false });
});

test('doctor: wrangler.jsonc as shipped deploys from Git (R23), and the checks see the old demo traps', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
  const shipped = checkWrangler(text);
  assert.equal(byId(shipped.findings, 'wrangler.d1')[0].level, 'ok'); // no id: resolved by name at deploy
  assert.equal(byId(shipped.findings, 'wrangler.crons')[0].level, 'ok');
  assert.equal(shipped.vars.AUTH_OPEN_READS, undefined);
  // the pre-R23 file: placeholder id + anonymous reads + no keep_vars
  const old = checkWrangler(text.replace('"database_name": "accessx-demo",', '"database_name": "accessx-demo", "database_id": "local-accessx-demo",')
    .replace('"keep_vars": true,', '"vars": { "AUTH_OPEN_READS": "1" },'));
  assert.deepEqual(old.findings.filter(x => x.level !== 'ok').map(x => `${x.level} ${x.id}`).sort(), ['error wrangler.d1', 'error wrangler.vars', 'warn wrangler.keep_vars']);
  const bare = checkWrangler('{ // comment\n "d1_databases": [{"database_name":"x","database_id":"0b7c1c7e-1111-4222-8333-944445555666"}], }');
  const ids = bare.findings.filter(x => x.level === 'error').map(x => x.id);
  assert.deepEqual(ids.sort(), ['wrangler.assets', 'wrangler.crons', 'wrangler.do', 'wrangler.ratelimits']);
  assert.equal(byId(bare.findings, 'wrangler.d1')[0].level, 'ok');
});

test('SCHEMA_VERSION is the newest migration (bump it with every migration)', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter(f => f.endsWith('.sql')).sort();
  assert.equal(`${SCHEMA_VERSION}.sql`, files[files.length - 1]);
});

test('GET /api/healthz: public, no-store, no tenant data; 503 when the schema is behind', async () => {
  const s = await boot({ ADMIN_TOKEN: 'owner-token-for-health-test-0123456789', AUTH_OPEN_READS: '0' });
  try {
    const r = await s.call('GET', '/api/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(r.body).sort(), ['at', 'db', 'ms', 'ok', 'schema']);
    assert.deepEqual(r.body.schema, { expected: SCHEMA_VERSION, applied: SCHEMA_VERSION });
    // Locked deployment: everything else needs a token, health does not.
    assert.equal((await s.call('GET', '/api/doors')).status, 401);
    // Deployed without migrating: the monitor goes red.
    s.server.store.sql.raw.exec(`DELETE FROM schema_migrations WHERE name = '${SCHEMA_VERSION}.sql'`);
    const behind = await s.call('GET', '/api/healthz');
    assert.equal(behind.status, 503);
    assert.equal(behind.body.ok, false);
    assert.match(behind.body.error, /apply migrations/);
  } finally { await s.close(); }
});

test('GET /api/platform/doctor: platform token only; findings without values', async () => {
  const platform = 'platform-token-for-doctor-test-0123456789';
  const secretsKey = key();
  const s = await boot({ ADMIN_TOKEN: 'owner-token-for-doctor-test-0123456789', PLATFORM_TOKEN: platform, SECRETS_KEY: secretsKey, PUBLIC_URL: 'http://127.0.0.1:1' });
  try {
    assert.equal((await s.call('GET', '/api/platform/doctor')).status, 401);
    assert.equal((await s.call('GET', '/api/platform/doctor', { token: 'owner-token-for-doctor-test-0123456789' })).status, 401);
    const r = await s.call('GET', '/api/platform/doctor', { token: platform });
    assert.equal(r.status, 200);
    assert.equal(r.body.doctor.ready, false); // http PUBLIC_URL, no SECURITY_CONTACT
    assert.ok(r.body.doctor.findings.some(f => f.id === 'PUBLIC_URL' && f.level === 'error'));
    assert.equal(r.body.doctor.findings.find(f => f.id === 'SECRETS_KEY').level, 'ok');
    const text = JSON.stringify(r.body);
    for (const v of [secretsKey, platform, 'owner-token-for-doctor-test-0123456789']) assert.ok(!text.includes(v));
  } finally { await s.close(); }
});

test('backup: a live copy restores with intact audit chains; tampering and a lost key are caught', async () => {
  const secretsKey = key();
  const s = await boot({ ADMIN_TOKEN: 'owner-token-for-backup-test-0123456789', SECRETS_KEY: secretsKey, ALLOW_HTTP_WEBHOOKS: '1' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessx-bk-'));
  try {
    const put = await s.call('PUT', '/api/alerts', { token: 'owner-token-for-backup-test-0123456789', body: { webhookUrl: 'https://hooks.acme-offices.com/x' } });
    assert.equal(put.status, 200); // a sealed secret now exists
    const file = backupNode({ dataDir: s.dataDir, out: path.join(dir, 'a.sqlite') }); // while the server runs

    const good = await verifyBackup(file, { secretsKey });
    assert.equal(good.ok, true, JSON.stringify(good.checks));
    assert.ok(good.tenants.find(t => t.id === 't_default').audit > 0);
    assert.match(good.checks.find(c => c.id === 'secrets').message, /1 sealed secret\(s\), all under keys/);
    // Rotated keyring (new first, old kept): still restorable.
    assert.equal((await verifyBackup(file, { secretsKey: `${key()},${secretsKey}` })).ok, true);
    // The key that sealed it is gone: every tenant would have to reconnect.
    const lost = await verifyBackup(file, { secretsKey: key() });
    assert.equal(lost.ok, false);
    assert.match(lost.checks.find(c => c.id === 'secrets').message, /does not hold/);

    // A changed audit row (the append-only trigger removed first) is caught.
    const { DatabaseSync } = require('node:sqlite');
    const bad = path.join(dir, 'tampered.sqlite');
    fs.copyFileSync(file, bad);
    const db = new DatabaseSync(bad);
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_events'").all()) db.exec(`DROP TRIGGER ${t.name}`);
    db.exec("UPDATE audit_events SET actor = 'mallory' WHERE seq = 2");
    db.close();
    const t = await verifyBackup(bad, { secretsKey });
    assert.equal(t.ok, false);
    assert.match(t.checks.find(c => c.id === 'audit:t_default').message, /BROKEN at 2/);
    assert.match(t.checks.find(c => c.id === 'objects').message, /missing: trigger audit_events/);

    // A SQL dump (the shape of `wrangler d1 export`) restores too.
    const src = new DatabaseSync(file, { readOnly: true });
    const lines = ['PRAGMA defer_foreign_keys=TRUE;'];
    const objects = src.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all();
    for (const o of objects.filter(x => x.type === 'table')) {
      lines.push(`${o.sql};`);
      for (const row of src.prepare(`SELECT * FROM "${o.name}"`).all()) {
        const vals = Object.values(row).map(v => (v === null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`));
        lines.push(`INSERT INTO "${o.name}" VALUES(${vals.join(',')});`);
      }
    }
    for (const o of objects.filter(x => x.type !== 'table')) lines.push(`${o.sql};`);
    src.close();
    fs.writeFileSync(path.join(dir, 'dump.sql'), lines.join('\n'));
    const dump = await verifyBackup(path.join(dir, 'dump.sql'), { secretsKey });
    assert.equal(dump.ok, true, JSON.stringify(dump.checks));
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
