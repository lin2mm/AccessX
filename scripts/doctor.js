#!/usr/bin/env node
/**
 * Go-live configuration check (docs/12-GO-LIVE.md). Exit code 1 = errors.
 *
 *   npm run doctor                               # this shell's env, Node deployment
 *   npm run doctor -- --env-file /etc/accessx.env
 *   npm run doctor -- --worker                   # wrangler.jsonc + `wrangler secret list` (names only)
 *   npm run doctor -- --url https://doors.example.com --platform-token "$PLATFORM_TOKEN"
 *                                                # ask the RUNNING server: the only way to
 *                                                # check a Worker's secret values
 *   options: --dev (development: errors become warnings), --json
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkConfig, checkWrangler, summary } = require(path.join(__dirname, '..', 'doctor-core'));

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const production = !flag('--dev');

/** KEY=value lines; quotes stripped; # comments. Enough for .env / .dev.vars. */
function parseEnvFile(text) {
  const env = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

function print(title, findings) {
  if (flag('--json')) return;
  const mark = { error: '✗', warn: '!', ok: '✓', info: '·' };
  console.log(`\n${title}`);
  for (const f of findings) {
    console.log(`  ${mark[f.level] || '?'} ${f.level.padEnd(5)} ${f.id.padEnd(26)} ${f.message}`);
    if (f.fix && (f.level === 'error' || f.level === 'warn')) console.log(`${' '.repeat(36)}→ ${f.fix}`);
  }
}

async function remote(base, platformToken) {
  const findings = [];
  const url = new URL(base);
  const h = await fetch(new URL('/api/healthz', url)).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) })).catch(error => ({ status: 0, body: { error: error.message } }));
  if (h.status === 200) findings.push({ level: 'ok', id: 'health', message: `database ok, schema ${h.body.schema && h.body.schema.applied} (${h.body.ms} ms)` });
  else findings.push({ level: 'error', id: 'health', message: `GET /api/healthz → ${h.status || 'unreachable'}: ${h.body.error || h.body.db || ''}` });
  const sec = await fetch(new URL('/.well-known/security.txt', url)).then(r => r.status).catch(() => 0);
  findings.push(sec === 200 ? { level: 'ok', id: 'security.txt', message: 'published' } : { level: production ? 'error' : 'warn', id: 'security.txt', message: `GET /.well-known/security.txt → ${sec}` });
  const page = await fetch(url).catch(() => null);
  if (page) {
    const csp = page.headers.get('content-security-policy') || '';
    const hsts = page.headers.get('strict-transport-security') || '';
    const directive = name => (csp.split(';').map(d => d.trim()).find(d => d.split(/\s+/)[0] === name) || '');
    const scripts = directive('script-src') || directive('default-src');
    findings.push(/'self'/.test(scripts) && !/unsafe-inline|unsafe-eval|\s\*(\s|$)/.test(scripts)
      ? { level: 'ok', id: 'csp', message: 'Content-Security-Policy: scripts from self only' }
      : { level: 'error', id: 'csp', message: `Content-Security-Policy missing or weak: ${csp.slice(0, 80) || '(none)'}` });
    if (url.protocol === 'https:' && !hsts) findings.push({ level: 'warn', id: 'hsts', message: 'no Strict-Transport-Security header', fix: 'Cloudflare → SSL/TLS → Edge Certificates → HSTS' });
  }
  const auth = await fetch(new URL('/api/auth', url)).then(r => r.json()).catch(() => ({}));
  if (auth.openReads && !platformToken) findings.push({ level: production ? 'error' : 'warn', id: 'AUTH_OPEN_READS', message: 'anonymous read-only access is ON on this deployment' });
  if (platformToken) {
    const r = await fetch(new URL('/api/platform/doctor', url), { headers: { authorization: `Bearer ${platformToken}` } });
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.doctor) findings.push(...body.doctor.findings);
    else findings.push({ level: 'error', id: 'platform/doctor', message: `GET /api/platform/doctor → ${r.status}: ${body.error || ''}` });
  } else findings.push({ level: 'info', id: 'platform/doctor', message: 'pass --platform-token to also check secret values on the server' });
  return findings;
}

(async () => {
  let all = [];
  if (opt('--url')) {
    const f = await remote(opt('--url'), opt('--platform-token') || process.env.PLATFORM_TOKEN || '');
    print(`Running deployment ${opt('--url')}`, f);
    all = f;
  } else if (flag('--worker')) {
    const file = opt('--wrangler') || path.join(__dirname, '..', 'wrangler.jsonc');
    const w = checkWrangler(fs.readFileSync(file, 'utf8'), { production });
    print(`Cloudflare deployment file ${path.relative(process.cwd(), file) || file}`, w.findings);
    let present = new Set();
    let note = null;
    if (!flag('--no-secrets')) {
      try {
        const out = execFileSync('npx', ['wrangler', 'secret', 'list', '--format', 'json', ...(opt('--wrangler') ? ['--config', file] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        present = new Set(JSON.parse(out.slice(out.indexOf('['))).map(s => s.name));
      } catch (error) { note = { level: 'warn', id: 'wrangler secret list', message: `could not list Worker secrets (${String(error.message).split('\n')[0].slice(0, 100)}); run \`npx wrangler login\` or pass --no-secrets` }; }
    }
    const env = { ...w.vars, ...(opt('--env-file') ? parseEnvFile(fs.readFileSync(opt('--env-file'), 'utf8')) : {}) };
    const c = checkConfig(env, { runtime: 'worker', production, present });
    if (note) c.unshift(note);
    print(`Worker settings (vars + ${present.size} secret name(s); values are checked by --url)`, c);
    all = [...w.findings, ...c];
  } else {
    const env = opt('--env-file') ? { ...parseEnvFile(fs.readFileSync(opt('--env-file'), 'utf8')) } : process.env;
    all = checkConfig(env, { runtime: 'node', production });
    print(`Node deployment settings (${opt('--env-file') || 'this shell\'s environment'})`, all);
  }
  const s = summary(all);
  if (flag('--json')) console.log(JSON.stringify({ ...s, findings: all }, null, 2));
  else console.log(`\n${s.ready ? '✓ ready' : '✗ NOT ready'}: ${s.errors} error(s), ${s.warnings} warning(s)${production ? '' : ' (development mode)'}\n`);
  process.exit(s.ready ? 0 : 1);
})().catch(error => { console.error(error); process.exit(2); });
