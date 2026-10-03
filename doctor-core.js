'use strict';
/**
 * Production configuration check (docs/12-GO-LIVE.md). Pure: takes an env
 * object, returns findings. Used by `npm run doctor` (before deploying) and by
 * GET /api/platform/doctor (the running server, the only place a Worker's
 * secret VALUES can be checked). Findings never contain secret values.
 *
 * Levels: error = do not go live; warn = works, but fix soon; ok; info.
 */
const rbac = require('./rbac-core');
const { billingConfigFromEnv } = require('./billing-core');

const WEAK = new Set(['owner-token', 'admin', 'changeme', 'change-me', 'password', 'secret', 'token', 'test', 'demo', 'platform-token']);

function b64Bytes(s) {
  // exactly what secrets-core accepts (standard base64 via atob)
  try { return atob(String(s).trim()).length; } catch { return -1; }
}

/**
 * Anonymous read-only access (the public demo). Explicit opt-in only, and
 * refused whenever real-lock credentials are configured: an open-reads
 * deployment with real locks would show doors, reports and the audit log to
 * anyone. Returns { open, refused }.
 */
function resolveOpenReads(env = {}, { demoDefault = false } = {}) {
  const wanted = env.AUTH_OPEN_READS === undefined || env.AUTH_OPEN_READS === '' ? demoDefault : env.AUTH_OPEN_READS === '1';
  const realLocks = Boolean(env.TTLOCK_CLIENT_ID);
  return { open: wanted && !realLocks, refused: wanted && realLocks };
}

/**
 * @param env      environment (values may be missing when only names are known)
 * @param options  runtime 'node' | 'worker'; production (default true);
 *                 present: Set of names known to be set whose values we cannot
 *                 see (Worker secrets listed by `wrangler secret list`).
 */
function checkConfig(env = {}, { runtime = 'node', production = true, present = new Set() } = {}) {
  const out = [];
  const add = (level, id, message, fix = '') => out.push({ level, id, message, ...(fix ? { fix } : {}) });
  const bad = production ? 'error' : 'warn';
  const val = k => (env[k] === undefined || env[k] === null ? '' : String(env[k]));
  const has = k => Boolean(val(k)) || present.has(k);
  const hidden = k => !val(k) && present.has(k);
  const token = (k, { required = false, what }) => {
    if (!has(k)) { if (required) add(bad, k, `${k} is not set: ${what}`, `set a long random value (openssl rand -base64 32)`); return; }
    if (hidden(k)) { add('info', k, `${k} is set (value checked by the running server: GET /api/platform/doctor)`); return; }
    const v = val(k);
    if (WEAK.has(v.toLowerCase()) || v.length < 24) add(bad, k, `${k} is short or a known demo value (${v.length} characters)`, 'use at least 32 random characters');
    else add('ok', k, `${k} is set and long enough`);
  };

  // --- who can get in
  token('ADMIN_TOKEN', { what: 'no bootstrap owner (fine if operators/SSO exist)' });
  if (!has('ADMIN_TOKEN') && !has('OPERATORS') && !has('PLATFORM_TOKEN')) add('error', 'ADMIN_TOKEN', 'nobody can sign in: set ADMIN_TOKEN, OPERATORS or PLATFORM_TOKEN');
  token('PLATFORM_TOKEN', { what: '' });
  if (val('OPERATORS')) {
    try { const ops = rbac.parseOperators(val('OPERATORS')); add('ok', 'OPERATORS', `${ops.length} fixed operator(s) parse`); } catch (error) { add('error', 'OPERATORS', `OPERATORS does not parse: ${error.message}`, 'npm run operator:new'); }
  }
  const reads = resolveOpenReads(env, { demoDefault: runtime === 'node' ? !has('TTLOCK_CLIENT_ID') : false });
  if (reads.refused) add('warn', 'AUTH_OPEN_READS', 'AUTH_OPEN_READS=1 is ignored because TTLOCK_CLIENT_ID is set (real locks): anonymous reads stay off', 'remove AUTH_OPEN_READS (wrangler.jsonc vars)');
  else if (reads.open) add(bad, 'AUTH_OPEN_READS', 'anonymous read-only access is ON: anyone can list doors, run reports and read the audit log', 'set AUTH_OPEN_READS=0 (wrangler.jsonc "vars") for anything but the public demo');
  else add('ok', 'AUTH_OPEN_READS', 'anonymous access is off');
  for (const k of ['ALLOW_HTTP_WEBHOOKS', 'ALLOW_HTTP_ISSUERS', 'MOCK_IDP', 'MOCK_IDP_AUTOCONFIGURE']) {
    if (val(k) === '1') add(bad, k, `${k}=1 is a development switch (plain-HTTP or fake identity provider)`, `remove ${k}`);
  }
  // R22 clickjacking: pages may only be framed by their own origin unless FRAME_ANCESTORS (Node) widens it.
  const fa = val('FRAME_ANCESTORS').trim();
  if (fa && runtime === 'worker') add('warn', 'FRAME_ANCESTORS', 'FRAME_ANCESTORS has no effect on the Worker', "edit frame-ancestors in public/_headers instead");
  else if (fa.split(/\s+/).includes('*')) add(bad, 'FRAME_ANCESTORS', 'FRAME_ANCESTORS=* lets any site frame the console (clickjacking of Approve / Open door)', 'list the embedding origins, e.g. https://intranet.example.com');
  else if (fa) add('warn', 'FRAME_ANCESTORS', `pages may be framed by: ${fa.slice(0, 120)}`, 'only for an intended embedding');
  if (val('COOKIE_SAMESITE').toLowerCase() === 'none') add('warn', 'COOKIE_SAMESITE', 'COOKIE_SAMESITE=None sends the session cookie on cross-site requests', 'only if the app must run inside another site\'s iframe');

  // --- secrets at rest
  if (!has('SECRETS_KEY')) add(bad, 'SECRETS_KEY', 'SECRETS_KEY is not set: SSO client secrets, TTLock passwords, alert webhooks and sealed codes cannot be encrypted', 'openssl rand -base64 32, then keep a copy offline');
  else if (hidden('SECRETS_KEY')) add('info', 'SECRETS_KEY', 'SECRETS_KEY is set (value checked by the running server)');
  else {
    const keys = val('SECRETS_KEY').split(',').map(s => s.trim()).filter(Boolean);
    const wrong = keys.filter(k => b64Bytes(k) !== 32);
    if (wrong.length) add('error', 'SECRETS_KEY', `${wrong.length} SECRETS_KEY entr${wrong.length > 1 ? 'ies are' : 'y is'} not 32 bytes of base64`, 'openssl rand -base64 32');
    else add('ok', 'SECRETS_KEY', `SECRETS_KEY: ${keys.length} key(s) of 32 bytes`);
  }

  // --- links people receive
  if (!has('PUBLIC_URL')) add(bad, 'PUBLIC_URL', 'PUBLIC_URL is not set: visitor invites, check-out links, alert links and Stripe return URLs need it', 'https://doors.example.com');
  else if (!hidden('PUBLIC_URL')) {
    let u = null;
    try { u = new URL(val('PUBLIC_URL')); } catch { /* invalid */ }
    if (!u || u.protocol !== 'https:' || u.pathname.replace(/\/+$/, '') !== '' || u.search || u.hash) add(bad, 'PUBLIC_URL', `PUBLIC_URL must be a bare https origin (got ${u ? u.origin + u.pathname : 'an invalid URL'})`, 'https://doors.example.com');
    else if (/(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/.test(u.hostname) || /^[\d.]+$|^\[/.test(u.hostname)) add(bad, 'PUBLIC_URL', `PUBLIC_URL points at ${u.hostname}, a placeholder or bare IP`);
    else add('ok', 'PUBLIC_URL', `links point at ${u.origin}`);
  }
  if (!has('SECURITY_CONTACT')) add(bad, 'SECURITY_CONTACT', 'no /.well-known/security.txt: researchers cannot report vulnerabilities', 'SECURITY_CONTACT=mailto:security@your-domain');
  else if (!hidden('SECURITY_CONTACT') && !val('SECURITY_CONTACT').split(',').every(c => /^(mailto:|https:|tel:)/.test(c.trim()))) add('error', 'SECURITY_CONTACT', 'SECURITY_CONTACT entries must be mailto:, https: or tel: URIs');
  else add('ok', 'SECURITY_CONTACT', 'security.txt is published');

  // --- locks
  if (!has('TTLOCK_CLIENT_ID') || !has('TTLOCK_CLIENT_SECRET')) add('warn', 'TTLOCK_CLIENT_ID', 'no TTLock app credentials: only demo locks; tenants cannot connect real locks', 'TTLock open platform → your app → client id / secret');
  else add('ok', 'TTLOCK_CLIENT_ID', 'TTLock app credentials are set');
  if (has('TTLOCK_CLIENT_ID')) {
    if (!has('TTLOCK_NOTIFY_SECRET')) add('warn', 'TTLOCK_NOTIFY_SECRET', 'no TTLock callback: lock alarms and visitor arrivals only arrive by polling (~15 min) or not at all', 'set a random value and register https://<host>/api/ttlock/notify/<value> in the TTLock console');
    else if (!hidden('TTLOCK_NOTIFY_SECRET') && val('TTLOCK_NOTIFY_SECRET').length < 24) add(bad, 'TTLOCK_NOTIFY_SECRET', 'TTLOCK_NOTIFY_SECRET is short: it is the only thing protecting the callback URL');
  }
  if (val('NUKI_API_BASE') && production) add('warn', 'NUKI_API_BASE', `NUKI_API_BASE is overridden (${val('NUKI_API_BASE')}): real locks are not reached through Nuki's cloud`);
  if (val('TTLOCK_API_BASE') && production) add('warn', 'TTLOCK_API_BASE', `TTLOCK_API_BASE is overridden (${val('TTLOCK_API_BASE')}): real locks are not reached through TTLock's cloud`);

  // --- audit evidence
  // R20. A running Worker (env.DB is a binding) without an R2 bucket bound as
  // BACKUPS has no automatic weekly export (backup-export-core.js).
  if (runtime === 'worker' && env.DB && typeof env.DB === 'object') {
    if (env.BACKUPS) add('ok', 'BACKUPS', 'weekly D1 export to R2 is on (GET /api/platform/backups)');
    else add('warn', 'BACKUPS', 'no R2 bucket bound as BACKUPS: no automatic weekly database export, only D1 Time Travel (30 days)', 'wrangler r2 bucket create accessx-backups, then add "r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "accessx-backups" }] to wrangler.jsonc');
  }
  if (production && val('USAGE_METER') === '1') add('warn', 'USAGE_METER', 'USAGE_METER=1 adds a D1 cost header to every response and counts rows per request: meant for load tests', 'remove USAGE_METER in production');
  if (!has('AUDIT_SIGNING_KEY')) add('warn', 'AUDIT_SIGNING_KEY', 'audit anchors are not signed: an auditor cannot tell your anchors from forged ones', 'npm run audit:keygen');
  else if (!hidden('AUDIT_SIGNING_KEY')) {
    try { const k = JSON.parse(val('AUDIT_SIGNING_KEY')); if (!k || k.kty !== 'OKP' || k.crv !== 'Ed25519' || !k.d || !k.x) throw new Error('not an Ed25519 private JWK with d and x'); add('ok', 'AUDIT_SIGNING_KEY', 'audit anchors are signed'); } catch (error) { add('error', 'AUDIT_SIGNING_KEY', `AUDIT_SIGNING_KEY is not a usable key: ${error.message}`, 'npm run audit:keygen'); }
  }

  // --- messages out
  const provider = val('EMAIL_PROVIDER');
  if (!provider && !present.has('EMAIL_PROVIDER')) add('warn', 'EMAIL_PROVIDER', 'no email: visitor codes, invitations and alerts cannot be emailed', 'EMAIL_PROVIDER=resend|postmark, EMAIL_API_KEY, EMAIL_FROM');
  else if (provider && !['resend', 'postmark'].includes(provider)) add('error', 'EMAIL_PROVIDER', `EMAIL_PROVIDER "${provider}" is not resend or postmark`);
  else {
    const miss = ['EMAIL_API_KEY', 'EMAIL_FROM'].filter(k => !has(k));
    if (miss.length) add('error', 'EMAIL_PROVIDER', `email is on but ${miss.join(', ')} ${miss.length > 1 ? 'are' : 'is'} missing`);
    else if (val('EMAIL_API_BASE') && production) add('warn', 'EMAIL_API_BASE', 'EMAIL_API_BASE is overridden: mail goes to a test server');
    else add('ok', 'EMAIL_PROVIDER', `email via ${provider || 'the configured provider'}`);
  }
  if (val('SMS_PROVIDER') === 'twilio') {
    const auth = (has('TWILIO_AUTH_TOKEN') || (has('TWILIO_API_KEY') && has('TWILIO_API_SECRET')));
    const miss = [!has('TWILIO_ACCOUNT_SID') && 'TWILIO_ACCOUNT_SID', !auth && 'TWILIO_AUTH_TOKEN (or API key + secret)', !has('SMS_FROM') && 'SMS_FROM'].filter(Boolean);
    if (miss.length) add('error', 'SMS_PROVIDER', `SMS is on but ${miss.join(', ')} missing`);
    else if (!val('SMS_MONTHLY_CAP')) add('warn', 'SMS_MONTHLY_CAP', 'no monthly SMS cap per tenant: a runaway integration can run up the Twilio bill', 'SMS_MONTHLY_CAP=500');
    else add('ok', 'SMS_PROVIDER', 'SMS via Twilio with a monthly cap');
  } else if (val('SMS_PROVIDER')) add('error', 'SMS_PROVIDER', `SMS_PROVIDER "${val('SMS_PROVIDER')}" is not twilio`);

  // --- self-service signup (R15)
  if (val('SIGNUP_ENABLED') === '1') {
    const miss = [!has('EMAIL_PROVIDER') && 'EMAIL_PROVIDER', !has('PUBLIC_URL') && 'PUBLIC_URL'].filter(Boolean);
    if (miss.length) add('error', 'SIGNUP_ENABLED', `signup is on but stays off without ${miss.join(' and ')} (the emailed link proves the address)`);
    else {
      if (!val('SIGNUP_TERMS_URL')) add('warn', 'SIGNUP_TERMS_URL', 'signup has no terms link: new customers accept terms they cannot read', 'SIGNUP_TERMS_URL=https://your-site/terms');
      else if (!/^https:\/\//.test(val('SIGNUP_TERMS_URL'))) add(bad, 'SIGNUP_TERMS_URL', 'SIGNUP_TERMS_URL must be an https URL');
      if (val('BILLING_ENABLED') !== '1') add('warn', 'SIGNUP_ENABLED', 'signup is open and billing is off: every new account is free with no end date');
      add('ok', 'SIGNUP_ENABLED', `self-service signup is on (at most ${val('SIGNUP_DAILY_LIMIT') || 50} per day)`);
      if (!has('TURNSTILE_SITE_KEY') && !has('TURNSTILE_SECRET_KEY')) add('warn', 'TURNSTILE_SITE_KEY', 'signup has no human check: scripted signups are only slowed by the rate limits', 'TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY (Cloudflare dashboard → Turnstile, free)');
    }
  }
  // Calendar invitations → visitor pre-registration (R17).
  if (has('CALENDAR_INBOUND_DOMAIN')) {
    const miss = [!has('EMAIL_PROVIDER') && 'EMAIL_PROVIDER', !has('PUBLIC_URL') && 'PUBLIC_URL'].filter(Boolean);
    if (miss.length) add('error', 'CALENDAR_INBOUND_DOMAIN', `calendar invitations stay off without ${miss.join(' and ')} (the organiser confirms by an emailed link)`);
    else if (val('CALENDAR_INBOUND_DOMAIN') && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(val('CALENDAR_INBOUND_DOMAIN') || '')) add(bad, 'CALENDAR_INBOUND_DOMAIN', 'CALENDAR_INBOUND_DOMAIN must be a bare domain such as in.doors.example.com');
    else add('ok', 'CALENDAR_INBOUND_DOMAIN', `calendar invitations to cal-…@${val('CALENDAR_INBOUND_DOMAIN') || '(domain)'} (Cloudflare Email Routing → this Worker)`);
  }
  if (has('CALENDAR_INBOUND_SECRET') && String(val('CALENDAR_INBOUND_SECRET') || 'x'.repeat(32)).length < 24) add(bad, 'CALENDAR_INBOUND_SECRET', 'CALENDAR_INBOUND_SECRET is short: use openssl rand -hex 24');
  // Cloudflare Turnstile on the signup page (R16): both keys or neither.
  if (has('TURNSTILE_SITE_KEY') !== has('TURNSTILE_SECRET_KEY')) add('error', 'TURNSTILE_SECRET_KEY', 'Turnstile needs both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY: with one of them the human check stays off');
  else if (has('TURNSTILE_SITE_KEY')) {
    if (/^[123]x0{10,}/.test(val('TURNSTILE_SITE_KEY') || '') || /^[123]x0{20,}/.test(val('TURNSTILE_SECRET_KEY') || '')) add(bad, 'TURNSTILE_SITE_KEY', 'Turnstile uses Cloudflare\'s test keys: they let every request through (or none)');
    else add('ok', 'TURNSTILE_SITE_KEY', 'signup asks for a Turnstile human check');
  }

  // --- billing
  if (val('BILLING_ENABLED') === '1' || present.has('BILLING_ENABLED')) {
    const c = billingConfigFromEnv(env);
    const problems = c.problems.filter(p => !present.has(p.split(' ')[0]));
    if (problems.length && val('BILLING_ENABLED') === '1') add('error', 'BILLING_ENABLED', `billing is enabled but inactive: check ${problems.join(', ')}`);
    else if (val('BILLING_ENABLED') === '1') {
      if (c.testMode && production) add('warn', 'STRIPE_SECRET_KEY', 'Stripe is in TEST mode: nobody is charged', 'switch to the live key when pricing is final');
      if (val('STRIPE_API_BASE') && production) add('warn', 'STRIPE_API_BASE', 'STRIPE_API_BASE is overridden: Stripe calls go to a test server');
      if (!has('STRIPE_THIN_WEBHOOK_SECRET')) add('warn', 'STRIPE_THIN_WEBHOOK_SECRET', 'Stripe meter errors are not received (docs/40-BILLING.md, Operations)');
      if (!has('PLATFORM_ALERT_WEBHOOK')) add('warn', 'PLATFORM_ALERT_WEBHOOK', 'billing problems are only visible in GET /api/platform/billing, nobody is told');
      if (!problems.length) add('ok', 'BILLING_ENABLED', `billing is active${c.testMode ? ' (test mode)' : ''}`);
    }
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** JSON with line and block comments and trailing commas (wrangler.jsonc). Throws on bad JSON. */
function parseJsonc(text) {
  const clean = String(text).replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s || '');
  return JSON.parse(clean.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Cloudflare deployment file (wrangler.jsonc, comments allowed). CLI only.
 */
function checkWrangler(text, { production = true } = {}) {
  const out = [];
  const add = (level, id, message, fix = '') => out.push({ level, id, message, ...(fix ? { fix } : {}) });
  const bad = production ? 'error' : 'warn';
  let w;
  try {
    w = parseJsonc(text);
  } catch (error) { add('error', 'wrangler', `wrangler.jsonc does not parse: ${error.message}`); return { findings: out, vars: {} }; }
  const db = ((w.d1_databases || [])[0]) || {};
  // R23: no id = `npm run deploy` (scripts/cf-deploy.js) finds or creates the database by name
  // and migrates it before deploying. A non-UUID id is a placeholder that can never deploy.
  if (!db.database_name) add(bad, 'wrangler.d1', 'no D1 database configured');
  else if (db.database_id === undefined || db.database_id === '') add('ok', 'wrangler.d1', `D1 ${db.database_name}: found or created by name at deploy (npm run deploy)`);
  else if (!UUID.test(String(db.database_id))) add(bad, 'wrangler.d1', `D1 database_id is "${db.database_id}", not a real database`, 'remove database_id (npm run deploy finds the database by name) or paste the real id');
  else add('ok', 'wrangler.d1', `D1 ${db.database_name} (${db.database_id.slice(0, 8)}…)`);
  if ((w.vars || {}).AUTH_OPEN_READS === '1') add(bad, 'wrangler.vars', 'wrangler.jsonc deploys AUTH_OPEN_READS=1: every Git deploy turns anonymous reads on', 'remove it from "vars"; set it in the dashboard only for a public demo');
  if (!w.keep_vars) add('warn', 'wrangler.keep_vars', 'without "keep_vars": true each deploy removes variables set in the dashboard', '"keep_vars": true');
  const rl = new Set((w.ratelimits || []).map(r => r.name));
  const missRl = ['RL_NOTIFY', 'RL_PUBLIC'].filter(n => !rl.has(n));
  if (missRl.length) add(bad, 'wrangler.ratelimits', `rate-limit bindings missing: ${missRl.join(', ')}`);
  else add('ok', 'wrangler.ratelimits', 'rate limits on the unauthenticated endpoints');
  if (!((w.triggers || {}).crons || []).length) add(bad, 'wrangler.crons', 'no cron trigger: codes are not revoked on schedule, alerts are not retried, usage is not metered');
  else add('ok', 'wrangler.crons', `cron ${w.triggers.crons.join(', ')}`);
  const first = ((w.assets || {}).run_worker_first) || [];
  const missFirst = ['/api/*', '/scim/*', '/.well-known/security.txt'].filter(p => !first.includes(p));
  if (missFirst.length) add(bad, 'wrangler.assets', `run_worker_first misses ${missFirst.join(', ')}: those requests would be served as static files`);
  if (!(w.observability && w.observability.enabled)) add('warn', 'wrangler.observability', 'Workers Logs are off: no error logs after an incident', '"observability": { "enabled": true }');
  else add('ok', 'wrangler.observability', 'Workers Logs are on');
  const bindings = (((w.durable_objects || {}).bindings) || []).map(b => b.name);
  if (!bindings.includes('TENANT_WRITER')) add('error', 'wrangler.do', 'Durable Object TENANT_WRITER missing: tenant writes are not serialised');
  return { findings: out, vars: w.vars || {} };
}

const summary = findings => ({
  errors: findings.filter(f => f.level === 'error').length,
  warnings: findings.filter(f => f.level === 'warn').length,
  ready: !findings.some(f => f.level === 'error'),
});

module.exports = { checkConfig, checkWrangler, resolveOpenReads, summary, parseJsonc, UUID };
