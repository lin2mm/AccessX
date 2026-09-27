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
import { createDemoVendor, staticMirror } from './vendor-demo.js';
import { createVendorAccounts } from './vendor-accounts.js';
import { createAuditOps } from './audit-ops.js';
import { createDnsTxtResolver } from './dns-core.js';
import { createAlerts } from './alerts-core.js';
import { createTenantQueue, busyResponse, QueueFullError } from './tenant-queue.js';

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
 * the limiter is best-effort — see docs/ARCHITECTURE.md.)
 */
let cached = null;
function apiFor(env) {
  const key = [env.ADMIN_TOKEN, env.OPERATORS, env.PLATFORM_TOKEN, env.AUTH_OPEN_READS, env.COOKIE_SAMESITE, env.SECRETS_KEY, env.ALLOW_HTTP_ISSUERS, env.TTLOCK_CLIENT_ID, env.TTLOCK_CLIENT_SECRET, env.TTLOCK_API_BASE, env.AUDIT_SIGNING_KEY, env.ALLOW_HTTP_WEBHOOKS, env.DOH_URL, env.PUBLIC_URL].join('\u0000');
  if (cached && cached.key === key && cached.db === env.DB) return cached.api;

  const sql = d1Adapter(env.DB);
  const store = createStore(sql);
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

  const auth = createAuthenticator({
    store,
    adminToken: env.ADMIN_TOKEN || '',
    operatorsJson: env.OPERATORS || '',
    platformToken: env.PLATFORM_TOKEN || '',
    openReads: env.AUTH_OPEN_READS !== '0',
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
    platformApp: { clientId: env.TTLOCK_CLIENT_ID || '', clientSecret: env.TTLOCK_CLIENT_SECRET || '' },
    log: (...a) => console.error(...a),
  });
  const auditOps = createAuditOps({ store, signingKeyJson: env.AUDIT_SIGNING_KEY || '', log: (...a) => console.error(...a), allowHttpWebhooks: env.ALLOW_HTTP_WEBHOOKS === '1' });
  const dns = createDnsTxtResolver({ dohUrl: env.DOH_URL || undefined });
  const alerts = createAlerts({ store, secretsKey: env.SECRETS_KEY || '', allowHttp: env.ALLOW_HTTP_WEBHOOKS === '1', publicUrl: env.PUBLIC_URL || '', log: (...a) => console.error(...a) });
  const api = createApi({ store, auth, vendorFor, vendorAccounts, auditOps, alerts, dns, ensureReady, log: (...a) => console.error(...a), cookieSameSite: env.COOKIE_SAMESITE || 'Lax', secretsKey: env.SECRETS_KEY || '', allowHttpIssuers: env.ALLOW_HTTP_ISSUERS === '1' });
  cached = { key, db: env.DB, api };
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

async function handleApi(request, env) {
  const req = await parseRequest(request, env);
  if (req instanceof Response) return req;
  const api = apiFor(env);
  // Writes go to the tenant's Durable Object, which runs them one at a time
  // (tenant-queue.js explains why). Reads, and writes whose tenant can't be
  // told from the credential (login, platform calls), are handled right here.
  if (env.TENANT_WRITER) {
    const tenantId = await api.writeKey(req);
    if (tenantId) {
      const stub = env.TENANT_WRITER.get(env.TENANT_WRITER.idFromName(tenantId));
      const headers = new Headers(request.headers);
      headers.delete('content-length'); // the body is re-serialized below
      return stub.fetch(new Request(request.url, {
        method: request.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      }));
    }
  }
  return toResponse(await api.handle(req));
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
    const req = await parseRequest(request, this.env);
    if (req instanceof Response) return req;
    let out;
    try {
      out = await this.queue.run('tenant', () => apiFor(this.env).handle(req));
    } catch (error) {
      if (!(error instanceof QueueFullError)) throw error;
      out = busyResponse(error, req.path);
    }
    const res = toResponse(out);
    res.headers.set('x-accessx-writer', 'durable-object');
    return res;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/scim/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
  /** Cron trigger (wrangler.jsonc "triggers.crons"): converge credentials. */
  async scheduled(event, env, ctx) {
    const api = apiFor(env);
    ctx.waitUntil(api.reconcileAll().then(results => console.log('reconcile', JSON.stringify(results))));
    ctx.waitUntil(api.maintenance().then(results => console.log('maintenance', JSON.stringify(results))));
  },
};
