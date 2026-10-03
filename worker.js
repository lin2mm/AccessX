/**
 * Cloudflare Worker adapter. All API behaviour lives in api-core.js
 * (shared with server.js); this file wires D1, the demo vendor, HTTP
 * plumbing and the cron-triggered reconciler.
 */
import aclDefaults from './data/acl.json';
import mirrorDefaults from './data/mirror.json';
import { d1Adapter } from './store/sql.js';
import { createStore } from './store/repo.js';
import { seedTenant } from './store/bootstrap.js';
import { createAuthenticator, DEFAULT_TENANT } from './auth-core.js';
import { createApi } from './api-core.js';
import { checkConfig, resolveOpenReads } from './doctor-core.js';
import { signupConfigFromEnv, withTurnstile } from './signup-core.js';
import { createDemoVendor, staticMirror } from './vendor-demo.js';
import { createVendorAccounts } from './vendor-accounts.js';
import { createAuditOps } from './audit-ops.js';
import { createDnsTxtResolver } from './dns-core.js';
import { createAlerts, emailConfigFromEnv, needsReconnectMessage } from './alerts-core.js';
import { createSms, smsConfigFromEnv } from './sms-core.js';
import { createTenantQueue, busyResponse, QueueFullError } from './tenant-queue.js';
import { createLimiters, allow } from './rate-limit-core.js';
import { securityTxt } from './security-txt.js';
import { billingConfigFromEnv, createStripe } from './billing-core.js';
import { maybeExport, exportBackup, listBackups } from './backup-export-core.js';

const MAX_BODY = 64 * 1024;

function toResponse(out) {
  const headers = new Headers({ 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...(out.headers || {}) });
  for (const c of out.cookies || []) headers.append('set-cookie', c);
  if (out.redirect) { headers.set('location', out.redirect); return new Response(null, { status: 302, headers }); }
  if (out.body === null || out.body === undefined) return new Response(null, { status: out.status, headers });
  headers.set('content-type', out.contentType || 'application/json');
  return new Response(JSON.stringify(out.body), { status: out.status, headers });
}
const json = (body, status = 200) => toResponse({ status, body });

async function appState(sql, key) {
  const row = await sql.first('SELECT value FROM app_state WHERE key = ?', [key]);
  return row ? JSON.parse(row.value) : null;
}

/**
 * One api instance per isolate+config, so the auth rate limiter and the
 * "ready" flag survive between requests. (Isolates are recycled at will;
 * the limiter is best-effort — see docs/01-ARCHITECTURE.md.)
 */
let cached = null;
let limiters = null; // per isolate; returns the RL_* bindings when configured
const tooMany = (type) => new Response(type === 'json' ? JSON.stringify({ ok: false, error: 'Too many requests. Please wait a minute and try again.' }) : 'too many requests', { status: 429, headers: { 'content-type': type === 'json' ? 'application/json' : 'text/plain', 'retry-after': '60', 'cache-control': 'no-store' } });
const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';
/** Platform view of the weekly R2 export (GET/POST /api/platform/backups); null without a BACKUPS binding. */
function backupsFor(env, sql) {
  if (!env.BACKUPS) return null;
  return {
    list: () => listBackups(env.BACKUPS),
    run: () => exportBackup({ sql, bucket: env.BACKUPS, keep: Number(env.BACKUP_KEEP || 8) }),
  };
}

function apiFor(env) {
  const key = [env.ADMIN_TOKEN, env.OPERATORS, env.PLATFORM_TOKEN, env.AUTH_OPEN_READS, env.COOKIE_SAMESITE, env.SECRETS_KEY, env.ALLOW_HTTP_ISSUERS, env.TTLOCK_CLIENT_ID, env.TTLOCK_CLIENT_SECRET, env.TTLOCK_API_BASE, env.NUKI_API_BASE, env.NUKI_POLL_MS, env.AUDIT_SIGNING_KEY, env.ALLOW_HTTP_WEBHOOKS, env.DOH_URL, env.PUBLIC_URL, env.EMAIL_PROVIDER, env.EMAIL_API_KEY, env.EMAIL_FROM, env.EMAIL_API_BASE, env.TTLOCK_NOTIFY_SECRET, env.SMS_PROVIDER, env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_API_KEY, env.TWILIO_API_SECRET, env.SMS_FROM, env.SMS_API_BASE, env.SMS_MONTHLY_CAP, env.SIGNUP_ENABLED, env.SIGNUP_DAILY_LIMIT, env.SIGNUP_TERMS_URL, env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY, env.TURNSTILE_VERIFY_URL, env.CALENDAR_INBOUND_DOMAIN, env.USAGE_METER].join('\u0000');
  if (cached && cached.key === key && cached.db === env.DB) return cached.api;

  // USAGE_METER=1 (load tests, R20): each /api response says what it cost in D1 (x-accessx-d1).
  const meter = env.USAGE_METER === '1' ? { queries: 0, rowsRead: 0, rowsWritten: 0 } : null;
  const sql = d1Adapter(env.DB, { meter });
  // Per-isolate snapshot cache (Workers have 128 MB): budget in rows, 0 = off.
  const store = createStore(sql, { snapshotCache: { maxRows: env.SNAPSHOT_CACHE_ROWS === undefined ? 100000 : Number(env.SNAPSHOT_CACHE_ROWS) } });
  const mirror = {
    // The hosted demo serves a read-only snapshot of the record mirror.
    async doc() { return (await appState(sql, 'mirror')) || mirrorDefaults; },
    sync: async body => staticMirror(null).sync(body),
    coverage: async () => staticMirror(await mirror.doc()).coverage(),
    query: async params => staticMirror(await mirror.doc()).query(params),
  };
  const demoVendor = createDemoVendor({ mirror });
  const emptyVendor = createDemoVendor({ locks: [] });
  const vendorFor = tenantId => (tenantId === DEFAULT_TENANT ? demoVendor : emptyVendor);

  const openReads = resolveOpenReads(env);
  if (openReads.refused) console.error('AUTH_OPEN_READS=1 ignored: TTLOCK_CLIENT_ID is set, anonymous reads stay off');
  const auth = createAuthenticator({
    store,
    adminToken: env.ADMIN_TOKEN || '',
    operatorsJson: env.OPERATORS || '',
    platformToken: env.PLATFORM_TOKEN || '',
    // Explicit opt-in (wrangler.jsonc vars sets it for the public demo), and
    // refused once real-lock credentials exist. `npm run doctor` flags it.
    openReads: openReads.open,
  });

  // First request after migration 0003: move the old JSON blob into rows.
  // Migration 0003 already copied audit_log into the tenant's chain.
  const ensureReady = async () => {
    const legacy = await appState(sql, 'acl');
    await seedTenant(store, DEFAULT_TENANT, {
      data: legacy || aclDefaults,
      legacyAudit: legacy ? null : aclDefaults.auditLog,
      source: legacy ? 'legacy app_state blob' : 'data/acl.json',
    });
  };

  const vendorAccounts = createVendorAccounts({
    store,
    secretsKey: env.SECRETS_KEY || '',
    apiBase: env.TTLOCK_API_BASE || '',
    nukiApiBase: env.NUKI_API_BASE || '',
    nukiPoll: env.NUKI_POLL_MS ? { pollMs: Math.max(50, Number(env.NUKI_POLL_MS) || 1500) } : {},
    platformApp: { clientId: env.TTLOCK_CLIENT_ID || '', clientSecret: env.TTLOCK_CLIENT_SECRET || '' },
    log: (...a) => console.error(...a),
    onNeedsReconnect: (tenantId, info) => alerts.send(tenantId, 'vendor_needs_reconnect', needsReconnectMessage(info)),
  });
  const auditOps = createAuditOps({ store, signingKeyJson: env.AUDIT_SIGNING_KEY || '', log: (...a) => console.error(...a), allowHttpWebhooks: env.ALLOW_HTTP_WEBHOOKS === '1' });
  const dns = createDnsTxtResolver({ dohUrl: env.DOH_URL || undefined });
  const alerts = createAlerts({ store, secretsKey: env.SECRETS_KEY || '', allowHttp: env.ALLOW_HTTP_WEBHOOKS === '1', publicUrl: env.PUBLIC_URL || '', email: emailConfigFromEnv(env), log: (...a) => console.error(...a) });
  const sms = createSms({ config: smsConfigFromEnv(env) });
  const billingConfig = billingConfigFromEnv(env);
  if (billingConfig.enabled && !billingConfig.active) console.error(`BILLING_ENABLED=1 but billing is off: check ${billingConfig.problems.join(', ')}`);
  const billing = billingConfig.active ? { config: billingConfig, stripe: createStripe(billingConfig) } : null;
  const api = createApi({ store, auth, vendorFor, vendorAccounts, auditOps, alerts, sms, dns, ensureReady, billing, doctor: () => checkConfig(env, { runtime: 'worker' }), backups: backupsFor(env, sql), signup: signupConfigFromEnv(env), calendarDomain: env.CALENDAR_INBOUND_DOMAIN || '', demoData: aclDefaults, log: (...a) => console.error(...a), cookieSameSite: env.COOKIE_SAMESITE || 'Lax', secretsKey: env.SECRETS_KEY || '', ttlockNotifySecret: env.TTLOCK_NOTIFY_SECRET || '', publicUrl: env.PUBLIC_URL || '', smsMonthlyCap: Number(env.SMS_MONTHLY_CAP || 0), allowHttpIssuers: env.ALLOW_HTTP_ISSUERS === '1' });
  cached = { key, db: env.DB, api, meter };
  return api;
}

/** Parse an /api or /scim request into api.handle() input (or an error Response). */
async function parseRequest(request, env) {
  const url = new URL(request.url);
  let body;
  // Okta/Entra may PUT a group with its full member list: larger limit for SCIM only.
  const limit = url.pathname.startsWith('/scim/') ? 1024 * 1024 : MAX_BODY;
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (Number(request.headers.get('content-length') || 0) > limit) return json({ ok: false, error: 'request body too large' }, 413);
    const text = await request.text();
    if (text.length > limit) return json({ ok: false, error: 'request body too large' }, 413);
    if (text) {
      try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'invalid JSON body' }, 400); }
    }
  }
  return {
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    body,
    headers: {
      authorization: request.headers.get('authorization') || '',
      cookie: request.headers.get('cookie') || '',
      'x-csrf-token': request.headers.get('x-csrf-token') || '',
    },
    ip: request.headers.get('cf-connecting-ip') || 'unknown',
    secure: url.protocol === 'https:',
    origin: env.PUBLIC_URL || url.origin,
  };
}

/**
 * D1 cost of one request (USAGE_METER=1 only). The meter is per isolate, so the
 * numbers are exact only when requests are sent one at a time (the load test does).
 */
// Same isolate = same meter: never count twice. (No random values at global scope in Workers.)
let isolateTag = null;
const isolate = () => (isolateTag = isolateTag || crypto.randomUUID().slice(0, 8));
const meterStart = () => (cached && cached.meter ? { ...cached.meter } : null);
function withMeter(res, start, inner = null) {
  if (!start || !cached || !cached.meter) return res;
  const m = cached.meter;
  const d = { q: m.queries - start.queries, read: m.rowsRead - start.rowsRead, written: m.rowsWritten - start.rowsWritten };
  // A write forwarded to the Durable Object: add what the DO reported.
  const fromDo = /q=(\d+);read=(\d+);written=(\d+);iso=(\w+)/.exec(inner || '');
  if (fromDo && fromDo[4] !== isolate()) { d.q += Number(fromDo[1]); d.read += Number(fromDo[2]); d.written += Number(fromDo[3]); }
  const out = new Response(res.body, res);
  out.headers.set('x-accessx-d1', `q=${d.q};read=${d.read};written=${d.written};iso=${isolate()}`);
  return out;
}

async function handleApi(request, env) {
  const req = await parseRequest(request, env);
  if (req instanceof Response) return req;
  const api = apiFor(env);
  const start = meterStart();
  // Writes go to the tenant's Durable Object, which runs them one at a time
  // (tenant-queue.js explains why). Reads, and writes whose tenant can't be
  // told from the credential (login, platform calls), are handled right here.
  if (env.TENANT_WRITER) {
    const tenantId = await api.writeKey(req);
    if (tenantId) {
      const stub = env.TENANT_WRITER.get(env.TENANT_WRITER.idFromName(tenantId));
      const headers = new Headers(request.headers);
      headers.delete('content-length'); // the body is re-serialized below
      const res = await stub.fetch(new Request(request.url, {
        method: request.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      }));
      return withMeter(res, start, res.headers.get('x-accessx-d1'));
    }
  }
  return withMeter(toResponse(await api.handle(req)), start);
}

/** TTLock record callback (form-encoded, secret in the path). Arrivals are written in each tenant's DO. */
async function handleTtlockNotify(request, env, url) {
  limiters = limiters || createLimiters(env);
  if (!(await allow(limiters, 'notify', clientIp(request)))) return tooMany('text');
  if (Number(request.headers.get('content-length') || 0) > 256 * 1024) return new Response('too large', { status: 413 });
  const text = await request.text();
  if (text.length > 256 * 1024) return new Response('too large', { status: 413 });
  const params = new URLSearchParams(text);
  const form = { records: params.getAll('records'), lockId: params.get('lockId') };
  const api = apiFor(env);
  const out = await api.ttlockNotify({ secret: decodeURIComponent(url.pathname.slice('/api/ttlock/notify/'.length)), form }, { dispatch: jobDispatcher(env) });
  return new Response(out.status === 200 ? 'success' : 'not found', { status: out.status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
}

/** Stripe webhook: raw body for the signature; the state change runs in the tenant's DO. */
async function handleStripeWebhook(request, env) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  limiters = limiters || createLimiters(env);
  if (!(await allow(limiters, 'stripe', clientIp(request)))) return tooMany('json');
  if (Number(request.headers.get('content-length') || 0) > 256 * 1024) return json(413, { ok: false, error: 'too large' });
  const rawBody = await request.text();
  if (rawBody.length > 256 * 1024) return json(413, { ok: false, error: 'too large' });
  try {
    const out = await apiFor(env).stripeWebhook({ rawBody, signature: request.headers.get('stripe-signature') || '' }, { dispatch: jobDispatcher(env) });
    return json(out.status, out.body);
  } catch (error) {
    console.error('stripe webhook failed', error);
    return json(500, { ok: false, error: 'webhook failed' }); // Stripe retries
  }
}

/** Writes that arrive without a tenant session run in that tenant's Durable Object. */
function jobDispatcher(env) {
  return env.TENANT_WRITER ? async (tenantId, job) => {
    const stub = env.TENANT_WRITER.get(env.TENANT_WRITER.idFromName(tenantId));
    const res = await stub.fetch(new Request('https://tenant-writer/__tenant/job', { method: 'POST', headers: { 'x-accessx-tenant': tenantId, 'content-type': 'application/json' }, body: JSON.stringify(job) }));
    return res.json();
  } : null;
}

/** Inbound calendar mail from a provider that POSTs raw MIME (Bearer CALENDAR_INBOUND_SECRET). */
async function handleCalendarHttp(request, env, url) {
  const secret = env.CALENDAR_INBOUND_SECRET || '';
  const given = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const enc = new TextEncoder();
  const a = enc.encode(given); const b = enc.encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  if (!secret || diff) {
    limiters = limiters || createLimiters(env);
    if (!(await allow(limiters, 'visitorLink', clientIp(request)))) return tooMany('json');
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > 600 * 1024) return Response.json({ ok: false, error: 'too large' }, { status: 413 });
  try {
    const out = await apiFor(env).calendarInbound({ to: request.headers.get('x-envelope-to') || url.searchParams.get('to') || '', raw }, { dispatch: jobDispatcher(env) });
    return Response.json({ ok: true, accepted: out.accepted }, { status: 202 });
  } catch (error) {
    console.error('calendar inbound failed', error);
    return Response.json({ ok: false, error: 'inbound failed' }, { status: 500 });
  }
}

/** Visitor self check-out / pre-registration (no login; the token in the body is the credential). */
async function handlePublicJson(request, env, fn, what, kind = 'visitorLink') {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  limiters = limiters || createLimiters(env);
  if (!(await allow(limiters, kind, clientIp(request)))) return tooMany('json');
  const text = await request.text();
  if (text.length > 4096) return json(413, { ok: false, error: 'too large' });
  let body;
  try { body = JSON.parse(text || '{}'); } catch { return json(400, { ok: false, error: 'invalid JSON' }); }
  try {
    const out = await apiFor(env)[fn](body, { dispatch: jobDispatcher(env), ip: clientIp(request) });
    const res = json(out.status, out.body);
    for (const [k, v] of Object.entries(out.headers || {})) res.headers.set(k, v);
    return res;
  } catch (error) {
    console.error(`${fn} failed`, error);
    return json(502, { ok: false, error: `${what} failed. Please try again, or contact your host.` });
  }
}

/**
 * One instance per tenant, worldwide. Serializes the tenant's writes so the
 * optimistic audit-head check never has to fight a burst (a 2,000-user SCIM
 * sync failed ~1.3 % of writes with 409 without this). It keeps no state of
 * its own: the data stays in D1, so the DO can be dropped at any time.
 */
export class TenantWriter {
  constructor(state, env) {
    this.env = env;
    this.queue = createTenantQueue({ maxDepth: Number(env.WRITE_QUEUE_MAX || 256) });
  }

  async fetch(request) {
    // Scheduled work for this tenant (worker.js scheduled()). Only the front
    // Worker reaches a DO, and it forwards nothing but /api/* and /scim/*,
    // so this path cannot be called from outside.
    if (new URL(request.url).pathname === '/__tenant/job') {
      // Arrival, lock alarm, visitor check-out or invite registration for this tenant (see jobDispatcher).
      const tenantId = request.headers.get('x-accessx-tenant');
      const job = await request.json();
      const out = await this.queue.run('tenant', () => apiFor(this.env).runTenantJob(tenantId, job));
      return Response.json(out);
    }
    if (new URL(request.url).pathname === '/__tenant/cron') {
      const tenantId = request.headers.get('x-accessx-tenant');
      const api = apiFor(this.env);
      const out = await this.queue.run('tenant', async () => ({ reconcile: await api.reconcileOne(tenantId), maintenance: await api.maintainOne(tenantId) }));
      return Response.json(out);
    }
    const req = await parseRequest(request, this.env);
    if (req instanceof Response) return req;
    let out;
    const api = apiFor(this.env);
    const start = meterStart();
    try {
      out = await this.queue.run('tenant', () => api.handle(req));
    } catch (error) {
      if (!(error instanceof QueueFullError)) throw error;
      out = busyResponse(error, req.path);
    }
    const res = withMeter(toResponse(out), start);
    res.headers.set('x-accessx-writer', 'durable-object');
    return res;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.startsWith('/api/ttlock/notify/')) return handleTtlockNotify(request, env, url);
    if (request.method === 'POST' && url.pathname === '/api/stripe/webhook') return handleStripeWebhook(request, env);
    if (request.method === 'POST' && url.pathname === '/api/visit-checkout') return handlePublicJson(request, env, 'visitCheckoutPublic', 'Check-out');
    if (request.method === 'POST' && url.pathname === '/api/visit-invite') return handlePublicJson(request, env, 'visitInvitePublic', 'Registration');
    if (request.method === 'POST' && url.pathname === '/api/signup') return handlePublicJson(request, env, 'signupPublic', 'Signup', 'signup');
    if (request.method === 'POST' && url.pathname === '/api/signup/verify') return handlePublicJson(request, env, 'signupVerifyPublic', 'Signup', 'signup');
    if (request.method === 'POST' && url.pathname === '/api/kiosk') return handlePublicJson(request, env, 'kioskPublic', 'Kiosk', 'kiosk');
    if (request.method === 'POST' && url.pathname === '/api/calendar-confirm') return handlePublicJson(request, env, 'calendarConfirmPublic', 'Confirmation');
    if (request.method === 'POST' && url.pathname === '/api/inbound/calendar') return handleCalendarHttp(request, env, url);
    if (url.pathname === '/.well-known/security.txt') {
      const body = securityTxt(env);
      return new Response(body || 'not found', { status: body ? 200 : 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': body ? 'public, max-age=86400' : 'no-store' } });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/scim/')) return handleApi(request, env);
    // The signup page may show the Cloudflare Turnstile widget (R16): only that
    // page's policy allows its script and frame, and only when it is configured.
    if (url.pathname === '/signup' && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) {
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set('content-security-policy', withTurnstile(out.headers.get('content-security-policy')));
      return out;
    }
    return env.ASSETS.fetch(request);
  },
  /**
   * Cloudflare Email Routing (R17): mail to cal-<key>@CALENDAR_INBOUND_DOMAIN (a
   * catch-all or per-address rule "Send to a Worker"). Meeting invitations become
   * drafts for their organiser to confirm; everything else is dropped silently
   * (no bounce: senders can be forged, and a bounce would confirm the address).
   */
  async email(message, env) {
    try {
      if (message.rawSize > 600 * 1024) return;
      const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
      const out = await apiFor(env).calendarInbound({ to: message.to, raw }, { dispatch: jobDispatcher(env) });
      if (out.accepted) console.log('calendar invitation', JSON.stringify({ tenant: out.tenantId, status: out.result && (out.result.status || out.result.reason) }));
    } catch (error) {
      console.error('calendar email failed', error);
    }
  },
  /** Cron trigger (wrangler.jsonc "triggers.crons"): converge credentials. */
  async scheduled(event, env, ctx) {
    const api = apiFor(env);
    // Weekly D1 -> R2 export (backup-export-core.js); needs the BACKUPS binding.
    if (env.BACKUPS) {
      ctx.waitUntil(maybeExport({ sql: d1Adapter(env.DB), bucket: env.BACKUPS, hourUtc: Number(env.BACKUP_HOUR_UTC || 17), keep: Number(env.BACKUP_KEEP || 8) })
        .then(r => { if (!r.skipped) console.log('backup', JSON.stringify(r)); })
        .catch(error => console.error('backup export failed', String(error && error.message || error))));
    }
    if (!env.TENANT_WRITER) {
      ctx.waitUntil(api.reconcileAll().then(results => console.log('reconcile', JSON.stringify(results))));
      ctx.waitUntil(api.maintenance().then(results => console.log('maintenance', JSON.stringify(results))));
      return;
    }
    // Each tenant's reconcile + maintenance runs inside its TenantWriter, queued
    // with that tenant's writes (no optimistic-concurrency fights with users).
    ctx.waitUntil((async () => {
      const results = await Promise.all((await api.tenantIds()).map(async tenantId => {
        try {
          const stub = env.TENANT_WRITER.get(env.TENANT_WRITER.idFromName(tenantId));
          const res = await stub.fetch(new Request('https://tenant-writer/__tenant/cron', { method: 'POST', headers: { 'x-accessx-tenant': tenantId } }));
          return { tenantId, ...(await res.json()) };
        } catch (error) {
          return { tenantId, error: String(error.message || error) };
        }
      }));
      console.log('cron', JSON.stringify(results));
    })());
  },
};
