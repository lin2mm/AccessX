#!/usr/bin/env node
'use strict';
/**
 * npm run deploy: the Cloudflare deploy used by Workers Builds (Git integration) and by hand.
 *
 *   1. find the D1 database named in wrangler.jsonc (create it if the account has none)
 *   2. write wrangler.deploy.jsonc = wrangler.jsonc + the real database_id (gitignored)
 *   3. apply the D1 migrations to it (remote), BEFORE the new code goes live
 *   4. wrangler deploy
 *   5. GET <workers.dev URL>/api/healthz until it answers 200 with ok:true (the endpoint
 *      answers 503 while the schema is behind the code), otherwise exit 1 = failed build
 *
 * Why not plain `wrangler deploy`: it never applies migrations, and `wrangler d1 migrations
 * apply --remote` refuses a config without database_id (workers-sdk #13632). Resolving the
 * id by name keeps the repo free of account-specific ids and placeholders.
 *
 * Flags: --dry-run  no Cloudflare calls: placeholder id, `wrangler deploy --dry-run`
 *        --no-health skip step 5
 *        --migrate-only  steps 1-3 (npm run cf:db:migrate:remote)
 *        --resolve-only  steps 1-2 (npm run backup -- d1 then uses --config wrangler.deploy.jsonc)
 * Env:   D1_LOCATION  location hint when the database is created (e.g. oc = Oceania)
 *        HEALTH_URL   base URL for step 5 when the Worker has no workers.dev URL
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseJsonc, UUID } = require('../doctor-core');

const DRY_ID = '00000000-0000-4000-8000-000000000000';
const PERMISSION_HELP = 'The Cloudflare API token cannot use D1. Workers Builds generates a token without D1 access: '
  + 'My Profile > API Tokens > "Workers Builds - …" > Edit > add Account > D1 > Edit, then retry the build '
  + '(docs/13-CLOUDFLARE-GIT-DEPLOY.md, step 3).';

class DeployError extends Error {}

function permissionProblem(text) {
  return /Authentication error|\[code: 10000\]|not authorized|Unauthorized|code: 7403/i.test(String(text || ''));
}

/**
 * The array printed by `wrangler d1 list --json` (wrangler 4.141: the raw API objects,
 * `{ uuid, name, … }`, JSON.stringify(dbs, null, 2), no banner). Tolerates other lines
 * before it, including ones that contain "[" such as "[WARNING]".
 */
function parseList(stdout) {
  const s = String(stdout || '');
  const end = s.lastIndexOf(']');
  for (const m of s.matchAll(/^\[/gm)) {
    let list;
    try { list = JSON.parse(s.slice(m.index, end + 1)); } catch { continue; }
    if (Array.isArray(list)) return list.map(d => ({ name: d.name, id: d.uuid || d.id || d.database_id }));
  }
  throw new DeployError(`wrangler d1 list --json printed no list: ${s.slice(0, 200)}`);
}

/**
 * The Worker's workers.dev URL from `wrangler deploy` output. Wrangler prints the targets
 * after "Deployed <name> triggers", one per line with "https://" on workers.dev ones;
 * prefer those over any other workers.dev URL earlier in the output.
 */
function workersDevUrl(stdout) {
  const s = String(stdout || '');
  const re = /https:\/\/[a-z0-9.-]+\.workers\.dev\b/i;
  const at = s.search(/Deployed \S+ triggers/);
  const m = (at >= 0 && s.slice(at).match(re)) || s.match(re);
  return m ? m[0] : null;
}

/**
 * @param {object} o
 * @param {string} o.configText  wrangler.jsonc contents
 * @param {(args:string[]) => Promise<{code:number, stdout:string, stderr:string}>} o.run  runs `wrangler <args>`
 * @param {(path:string, text:string) => void} o.write
 * @param {typeof fetch} [o.fetch]
 */
async function deploy({ configText, run, write, fetch: fetchFn = globalThis.fetch, log = console.log, env = {}, dryRun = false, health = true, migrateOnly = false, resolveOnly = false, sleep = ms => new Promise(r => setTimeout(r, ms)), outFile = 'wrangler.deploy.jsonc', tries = 12, waitMs = 5000 }) {
  const cfg = parseJsonc(configText);
  const dbs = cfg.d1_databases || [];
  if (!dbs.length || !dbs[0].database_name) throw new DeployError('wrangler.jsonc has no d1_databases[0].database_name');
  const db = dbs[0];
  const steps = [];
  const wrangler = async (args, what) => {
    steps.push(args.join(' '));
    const r = await run(args);
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.code !== 0) {
      if (/necessary to set a CLOUDFLARE_API_TOKEN/.test(text)) throw new DeployError(`${what} failed: not logged in to Cloudflare. By hand: npx wrangler login, then npm run deploy. In Workers Builds the token is provided; check Settings > Build > API token.`);
      throw new DeployError(permissionProblem(text) ? `${what} failed. ${PERMISSION_HELP}` : `${what} failed (wrangler exit ${r.code})`);
    }
    return r;
  };

  // 1. the database id
  let id = db.database_id;
  if (id && !UUID.test(String(id))) throw new DeployError(`wrangler.jsonc database_id "${id}" is a placeholder: remove it (resolved by name) or paste the real id`);
  if (!id && dryRun) { id = DRY_ID; log(`dry run: placeholder id for D1 "${db.database_name}"`); }
  if (!id) {
    const find = async () => (parseList((await wrangler(['d1', 'list', '--json'], 'Listing D1 databases')).stdout).find(d => d.name === db.database_name) || {}).id;
    id = await find();
    if (id) log(`D1 "${db.database_name}" found: ${id.slice(0, 8)}…`);
    else {
      log(`D1 "${db.database_name}" not found in this account: creating it`);
      // --update-config=false: never let wrangler edit wrangler.jsonc (it would add an id to the repo file)
      await wrangler(['d1', 'create', db.database_name, '--update-config=false', ...(env.D1_LOCATION ? ['--location', env.D1_LOCATION] : [])], `Creating D1 "${db.database_name}"`);
      id = await find();
      if (!id) throw new DeployError(`D1 "${db.database_name}" was created but is not listed`);
      log(`D1 "${db.database_name}" created: ${id.slice(0, 8)}…`);
    }
  }

  // 2. the deploy config (same directory, so main/assets/migrations paths still resolve)
  const out = { ...cfg, d1_databases: [{ ...db, database_id: id }, ...dbs.slice(1)] };
  write(outFile, `// Generated by scripts/cf-deploy.js from wrangler.jsonc. Do not edit or commit.\n${JSON.stringify(out, null, 2)}\n`);

  if (resolveOnly) return { id, steps, url: null, healthy: null };

  // 3. migrations first: they are additive, so the old code keeps working on the new schema
  if (!dryRun) await wrangler(['d1', 'migrations', 'apply', db.binding || 'DB', '--remote', '--config', outFile], 'Applying D1 migrations');

  if (migrateOnly) return { id, steps, url: null, healthy: null };

  // 4. deploy
  const deployed = await wrangler(['deploy', '--config', outFile, ...(dryRun ? ['--dry-run', '--outdir', env.DRY_OUTDIR || path.join(require('node:os').tmpdir(), 'accessx-wdry')] : [])], 'wrangler deploy');
  if (dryRun || !health) return { id, steps, url: null, healthy: null };

  // 5. health
  const base = (env.HEALTH_URL || workersDevUrl(`${deployed.stdout}\n${deployed.stderr}`) || '').replace(/\/+$/, '');
  if (!base) { log('No workers.dev URL in the deploy output and no HEALTH_URL: health check skipped'); return { id, steps, url: null, healthy: null }; }
  // An HTTP answer that is not 200 {ok:true} fails the build (503 = schema behind, D1 down,
  // 5xx = broken code). Never getting any answer (a new workers.dev subdomain can take
  // minutes to resolve) is not evidence against the code: warn, do not fail.
  let last = ''; let answered = false;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetchFn(`${base}/api/healthz`, { headers: { 'cache-control': 'no-cache' } });
      answered = true;
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.ok) { log(`healthy: ${base}/api/healthz (schema ${body.schema && body.schema.applied})`); return { id, steps, url: base, healthy: true }; }
      last = `HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`;
    } catch (error) { last = error.message; }
    if (i < tries) await sleep(waitMs);
  }
  if (!answered) {
    log(`WARNING: deployed, but ${base}/api/healthz never answered (${last}). A new workers.dev subdomain can take a few minutes: open the URL by hand, then run npm run doctor -- --url ${base}`);
    return { id, steps, url: base, healthy: null };
  }
  throw new DeployError(`deployed, but ${base}/api/healthz is not healthy: ${last}`);
}

function runWrangler(args) {
  return new Promise(resolve => {
    const child = spawn('npx', ['wrangler', ...args], { env: { ...process.env, CI: process.env.CI || 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const quiet = args[0] === 'd1' && args[1] === 'list';
    child.stdout.on('data', d => { stdout += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d; process.stderr.write(d); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', error => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  process.chdir(root);
  const args = process.argv.slice(2);
  deploy({
    configText: fs.readFileSync('wrangler.jsonc', 'utf8'),
    run: runWrangler,
    write: (file, text) => fs.writeFileSync(file, text),
    env: process.env,
    dryRun: args.includes('--dry-run'),
    health: !args.includes('--no-health'),
    migrateOnly: args.includes('--migrate-only'),
    resolveOnly: args.includes('--resolve-only'),
    log: m => console.log(`[deploy] ${m}`),
  }).then(r => {
    console.log(`[deploy] done${r.url ? `: ${r.url}` : ''}`);
  }, error => {
    console.error(`[deploy] FAILED: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { deploy, parseList, workersDevUrl, permissionProblem, DeployError, DRY_ID };
