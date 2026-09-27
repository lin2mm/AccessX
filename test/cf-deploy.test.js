'use strict';
// R23: npm run deploy (scripts/cf-deploy.js), the command Workers Builds runs on every push
// to the production branch. Wrangler and the network are fakes; the order is the contract:
// resolve the database, migrate, deploy, health-check.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { deploy, parseList, workersDevUrl, DRY_ID } = require('../scripts/cf-deploy');
const { checkWrangler, parseJsonc } = require('../doctor-core');

const REPO_CONFIG = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
const ID = '3f2a9c1e-1111-4222-8333-944455556666';
const listJson = names => JSON.stringify(names.map((name, i) => ({ uuid: i ? `aaaaaaaa-0000-4000-8000-00000000000${i}` : ID, name })));

function fakes({ existing = ['accessx-demo'], fail = {}, healthSeq = [[200, { ok: true, schema: { applied: '0025_access_review' } }]], deployOut = 'Deployed accessx-demo triggers\n  https://accessx-demo.acme.workers.dev\n' } = {}) {
  const calls = []; const files = {}; const db = [...existing]; let h = 0; const fetched = [];
  return {
    calls, files, fetched,
    run: async args => {
      const cmd = args.slice(0, args[0] === 'd1' ? 2 : 1).join(' ');
      calls.push(cmd);
      if (fail[cmd]) return { code: 1, stdout: '', stderr: fail[cmd] };
      if (cmd === 'd1 list') return { code: 0, stdout: listJson(db), stderr: '' };
      if (cmd === 'd1 create') { db.unshift(args[2]); return { code: 0, stdout: 'created', stderr: '' }; }
      if (cmd === 'deploy') return { code: 0, stdout: deployOut, stderr: '' };
      return { code: 0, stdout: 'ok', stderr: '' };
    },
    write: (f, t) => { files[f] = t; },
    fetch: async url => { fetched.push(url); const [status, body] = healthSeq[Math.min(h++, healthSeq.length - 1)]; return { status, json: async () => body }; },
    sleep: async () => {},
    log: () => {},
  };
}

test('existing database: found by name, migrated, then deployed, then healthy', async () => {
  const f = fakes();
  const r = await deploy({ configText: REPO_CONFIG, ...f });
  assert.deepStrictEqual(f.calls, ['d1 list', 'd1 migrations', 'deploy']);
  assert.strictEqual(r.id, ID);
  assert.strictEqual(r.url, 'https://accessx-demo.acme.workers.dev');
  assert.deepStrictEqual(f.fetched, ['https://accessx-demo.acme.workers.dev/api/healthz']);
  const written = parseJsonc(f.files['wrangler.deploy.jsonc']);
  assert.strictEqual(written.d1_databases[0].database_id, ID);
  assert.strictEqual(written.d1_databases[0].binding, 'DB');
  assert.ok(r.steps.includes('d1 migrations apply DB --remote --config wrangler.deploy.jsonc'), r.steps.join(' | '));
  assert.ok(r.steps.includes('deploy --config wrangler.deploy.jsonc'));
});

test('no database yet: created (with the location hint) before migrating', async () => {
  const f = fakes({ existing: ['something-else'] });
  const r = await deploy({ configText: REPO_CONFIG, ...f, env: { D1_LOCATION: 'oc' } });
  assert.deepStrictEqual(f.calls, ['d1 list', 'd1 create', 'd1 list', 'd1 migrations', 'deploy']);
  assert.ok(r.steps.includes('d1 create accessx-demo --location oc'));
  assert.strictEqual(r.id, ID);
});

test('a failed migration stops the deploy: the old code keeps running', async () => {
  const f = fakes({ fail: { 'd1 migrations': 'SQLITE_ERROR' } });
  await assert.rejects(deploy({ configText: REPO_CONFIG, ...f }), /Applying D1 migrations failed/);
  assert.ok(!f.calls.includes('deploy'));
});

test('the default Workers Builds token (no D1 permission) gets a precise fix', async () => {
  const f = fakes({ fail: { 'd1 list': 'A request to the Cloudflare API failed. Authentication error [code: 10000]' } });
  await assert.rejects(deploy({ configText: REPO_CONFIG, ...f }), /D1 > Edit/);
});

test('health: waits for 200 ok, fails the build when the schema stays behind', async () => {
  const ok = fakes({ healthSeq: [[503, { ok: false }], [200, { ok: true, schema: {} }]] });
  assert.strictEqual((await deploy({ configText: REPO_CONFIG, ...ok })).healthy, true);
  assert.strictEqual(ok.fetched.length, 2);
  const behind = fakes({ healthSeq: [[503, { ok: false, schema: { expected: '0025', applied: '0024' } }]] });
  await assert.rejects(deploy({ configText: REPO_CONFIG, ...behind, tries: 3 }), /not healthy: HTTP 503/);
  assert.strictEqual(behind.fetched.length, 3);
});

test('dry run and migrate-only', async () => {
  const dry = fakes();
  const r = await deploy({ configText: REPO_CONFIG, ...dry, dryRun: true });
  assert.deepStrictEqual(dry.calls, ['deploy']);
  assert.strictEqual(r.id, DRY_ID);
  assert.ok(r.steps[0].includes('--dry-run'));
  const mig = fakes();
  await deploy({ configText: REPO_CONFIG, ...mig, migrateOnly: true });
  assert.deepStrictEqual(mig.calls, ['d1 list', 'd1 migrations']);
});

test('a placeholder id is refused; a real id skips the lookup', async () => {
  const placeholder = REPO_CONFIG.replace('"database_name": "accessx-demo",', '"database_name": "accessx-demo", "database_id": "local-accessx-demo",');
  await assert.rejects(deploy({ configText: placeholder, ...fakes() }), /placeholder/);
  const real = REPO_CONFIG.replace('"database_name": "accessx-demo",', `"database_name": "accessx-demo", "database_id": "${ID}",`);
  const f = fakes();
  await deploy({ configText: real, ...f });
  assert.deepStrictEqual(f.calls, ['d1 migrations', 'deploy']);
});

test('the shipped wrangler.jsonc is safe to deploy from Git', () => {
  const w = parseJsonc(REPO_CONFIG);
  assert.strictEqual(w.d1_databases[0].database_id, undefined, 'no account-specific id or placeholder in the repo');
  assert.strictEqual((w.vars || {}).AUTH_OPEN_READS, undefined, 'a Git deploy must not turn anonymous reads on');
  assert.strictEqual(w.keep_vars, true, 'dashboard variables survive deploys');
  assert.deepStrictEqual(checkWrangler(REPO_CONFIG).findings.filter(x => x.level !== 'ok'), []);
  const pkg = require('../package.json');
  assert.match(pkg.scripts.deploy, /cf-deploy\.js$/);
  assert.strictEqual(pkg.scripts['cf:deploy'], pkg.scripts.deploy, 'no deploy path that skips migrations');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8').includes('wrangler.deploy.jsonc'));
});

test('output parsers', () => {
  assert.deepStrictEqual(parseList(`banner\n${listJson(['a'])}`), [{ name: 'a', id: ID }]);
  assert.strictEqual(workersDevUrl('x https://a-b.c-d.workers.dev/ y'), 'https://a-b.c-d.workers.dev');
  assert.strictEqual(workersDevUrl('no url'), null);
});
