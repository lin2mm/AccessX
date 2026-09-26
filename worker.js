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
  const key = [env.ADMIN_TOKEN, env.OPERATORS, env.PLATFORM_TOKEN, env.AUTH_OPEN_READS, env.COOKIE_SAMESITE, env.SECRETS_KEY].join('\u0000');
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

  const api = createApi({ store, auth, vendorFor, ensureReady, log: (...a) => console.error(...a), cookieSameSite: env.COOKIE_SAMESITE || 'Lax' });
  cached = { key, db: env.DB, api };
  return api;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  let body;
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return json({ ok: false, error: 'request body too large' }, 413);
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: 'request body too large' }, 413);
    if (text) {
      try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'invalid JSON body' }, 400); }
    }
  }
  const out = await apiFor(env).handle({
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
  });
  return toResponse(out);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/scim/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
  /** Cron trigger (wrangler.jsonc "triggers.crons"): converge credentials. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(apiFor(env).reconcileAll().then(results => console.log('reconcile', JSON.stringify(results))));
  },
};
