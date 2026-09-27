/**
 * Express adapter. All API behaviour lives in api-core.js (shared with
 * the Cloudflare Worker); this file only does HTTP plumbing, static
 * files, storage wiring and the reconcile timer.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { nodeSqliteAdapter, migrateNode } = require('./store/sqlite-node');
const { createStore } = require('./store/repo');
const { seedTenant } = require('./store/bootstrap');
const { createAuthenticator, DEFAULT_TENANT } = require('./auth-core');
const { createApi } = require('./api-core');
const { createDemoVendor } = require('./vendor-demo');
const { createTTLockVendor, fileMirror } = require('./vendor-ttlock');
const { TTLock } = require('./ttlock');
const { createVendorAccounts } = require('./vendor-accounts');
const { createAuditOps } = require('./audit-ops');
const { createDnsTxtResolver } = require('./dns-core');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data', 'runtime');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- storage ---------------- */
const sql = nodeSqliteAdapter(path.join(DATA_DIR, 'accessx.sqlite'));
migrateNode(sql, path.join(__dirname, 'migrations'));
// Snapshot cache budget in rows across tenants (0 = off). ~1 KB per row in memory.
const store = createStore(sql, { snapshotCache: { maxRows: process.env.SNAPSHOT_CACHE_ROWS === undefined ? 500000 : Number(process.env.SNAPSHOT_CACHE_ROWS) } });

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const readJsonl = file => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return null; }
};

/** First boot: import the pre-SQL runtime state if present, else the seed. */
async function ensureReady() {
  const legacyState = readJson(path.join(DATA_DIR, 'acl.json'));
  const data = legacyState || readJson(path.join(__dirname, 'data', 'acl.json')) || {};
  const result = await seedTenant(store, DEFAULT_TENANT, {
    data,
    sealedAudit: readJsonl(path.join(DATA_DIR, 'audit.jsonl')),
    legacyAudit: data.auditLog,
    source: legacyState ? 'legacy DATA_DIR/acl.json' : 'data/acl.json',
  });
  if (result.seeded && legacyState) {
    // Keep the old files for rollback, but make it obvious they are retired.
    for (const f of ['acl.json', 'audit.jsonl']) {
      const from = path.join(DATA_DIR, f);
      if (fs.existsSync(from)) fs.renameSync(from, `${from}.migrated`);
    }
  }
}

/* ---------------- vendors ---------------- */
const tt = new TTLock();
const demoVendor = createDemoVendor({ mirror: fileMirror() });
const liveVendor = tt.demo ? null : createTTLockVendor(tt);
// TTLock credentials are per deployment today → default tenant only.
// Per-tenant vendor accounts are the next step (see docs/ARCHITECTURE.md).
// Other tenants get an EMPTY simulated fleet: lock ids belong to a vendor
// account, and one tenant must never see (let alone open) another's doors.
const emptyVendor = createDemoVendor({ locks: [] });
const vendorFor = tenantId => (tenantId === DEFAULT_TENANT ? liveVendor || demoVendor : emptyVendor);
// Per-tenant TTLock accounts (owners connect their own; tokens sealed with SECRETS_KEY).
// A connected account overrides vendorFor() for that tenant.
const { createAlerts, emailConfigFromEnv, needsReconnectMessage } = require('./alerts-core');
const vendorAccounts = createVendorAccounts({
  store,
  secretsKey: process.env.SECRETS_KEY || '',
  apiBase: process.env.TTLOCK_API_BASE || '', // deployment-level override (tests, egress proxy) — never per tenant
  platformApp: { clientId: process.env.TTLOCK_CLIENT_ID || '', clientSecret: process.env.TTLOCK_CLIENT_SECRET || '' },
  log: (...a) => console.error(...a),
  // `alerts` is created below; the hook only runs later, at request time.
  onNeedsReconnect: (tenantId, info) => alerts.send(tenantId, 'vendor_needs_reconnect', needsReconnectMessage(info)),
});

const auth = createAuthenticator({
  store,
  adminToken: process.env.ADMIN_TOKEN || '',
  operatorsJson: process.env.OPERATORS || '',
  platformToken: process.env.PLATFORM_TOKEN || '',
  openReads: process.env.AUTH_OPEN_READS === undefined ? tt.demo : process.env.AUTH_OPEN_READS === '1',
});
// Signed audit anchors (AUDIT_SIGNING_KEY, Ed25519 JWK) + retention.
const alerts = createAlerts({ store, secretsKey: process.env.SECRETS_KEY || '', allowHttp: process.env.ALLOW_HTTP_WEBHOOKS === '1', publicUrl: process.env.PUBLIC_URL || '', email: emailConfigFromEnv(process.env), log: (...a) => console.error(...a) });
const auditOps = createAuditOps({ store, signingKeyJson: process.env.AUDIT_SIGNING_KEY || '', log: (...a) => console.error(...a), allowHttpWebhooks: process.env.ALLOW_HTTP_WEBHOOKS === '1' });
// SSO domain proof (TXT over DoH). Tests set overrides via `dns.set()`.
const dns = createDnsTxtResolver({ dohUrl: process.env.DOH_URL || undefined });
const { createTenantQueue, busyResponse, QueueFullError } = require('./tenant-queue');
const WRITE_QUEUE_OFF = process.env.WRITE_QUEUE === 'off';
const writeQueue = createTenantQueue({ maxDepth: Number(process.env.WRITE_QUEUE_MAX || 256) });
const api = createApi({
  store, auth, vendorFor, vendorAccounts, auditOps, alerts, dns, ensureReady,
  serialize: (tenantId, fn) => (WRITE_QUEUE_OFF ? fn() : writeQueue.run(tenantId, fn)), log: (...a) => console.error(...a),
  cookieSameSite: process.env.COOKIE_SAMESITE || 'Lax',
  secretsKey: process.env.SECRETS_KEY || '',
  // The bundled mock IdP runs on plain http; real issuers must be https.
  allowHttpIssuers: process.env.MOCK_IDP === '1',
});

/* ---------------- HTTP ---------------- */
const app = express();
app.disable('x-powered-by');
// Mirrors public/_headers (used by the Cloudflare build).
// No inline scripts or handlers: script-src 'self' blocks injected <script>/on*=.
// connect-src/img-src 'self' stop exfiltration of tokens or data.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'";
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
// SCIM clients (Entra ID, Okta) send application/scim+json.
app.use('/api', express.json({ limit: '64kb', type: ['application/json'] }));
// Okta/Entra may PUT a group with its full member list: allow larger bodies here only.
app.use('/scim', express.json({ limit: '1mb', type: ['application/json', 'application/scim+json'] }));
app.use(['/api', '/scim'], async (req, res) => {
  // NOTE: x-forwarded-for is client-controlled unless a trusted proxy
  // overwrites it. Behind a proxy, configure Express "trust proxy" instead.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  const request = {
    method: req.method,
    path: req.originalUrl.split('?')[0],
    query: new URLSearchParams(req.originalUrl.split('?')[1] || ''),
    body: req.body,
    headers: req.headers,
    ip,
    secure: proto === 'https',
    origin: process.env.PUBLIC_URL || `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`,
  };
  // Writes of one tenant run one at a time (tenant-queue.js); reads never wait.
  let out;
  try {
    // WRITE_QUEUE=off exists for tests that must exercise the in-transaction
    // guards directly (the queue would serialize the race away).
    const key = WRITE_QUEUE_OFF ? null : await api.writeKey(request);
    out = await writeQueue.run(key, () => api.handle(request));
  } catch (error) {
    if (!(error instanceof QueueFullError)) throw error;
    out = busyResponse(error, request.path);
  }
  for (const c of out.cookies || []) res.append('Set-Cookie', c);
  if (out.headers) res.set(out.headers);
  if (out.redirect) return res.redirect(302, out.redirect);
  if (out.body === null || out.body === undefined) return res.status(out.status).end();
  if (out.contentType) return res.status(out.status).type(out.contentType).send(JSON.stringify(out.body));
  return res.status(out.status).json(out.body);
});
if (process.env.MOCK_IDP === '1') {
  // Demo/test identity provider. NEVER enable in production: anyone can
  // "log in" as any of its users.
  console.warn('WARNING: MOCK_IDP=1 — a fake identity provider is mounted at /mock-idp (demo only)');
  app.use('/mock-idp', require('./support/mock-idp').createMockIdp({ basePath: '/mock-idp' }).router);
}
app.use(express.static(path.join(__dirname, 'public')));
// Malformed JSON and oversize bodies → JSON errors, not HTML stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.status || 400).json({ ok: false, error: err.type === 'entity.too.large' ? 'request body too large' : 'invalid JSON body' });
});

/* ---------------- reconcile timer ---------------- */
function startReconciler(minutes = Number(process.env.RECONCILE_INTERVAL_MIN ?? 15)) {
  if (!minutes) return null;
  const timer = setInterval(() => {
    api.reconcileAll()
      .then(results => results.filter(r => r.revoked || r.expired || r.pendingRemoval || r.failed || r.escalated || r.error)
        .forEach(r => console.log('reconcile', JSON.stringify(r))))
      .catch(error => console.error('reconcile failed', error));
    // Anchors at most daily per tenant; retention only below delivered anchors.
    api.maintenance()
      .then(results => results.filter(r => r.anchored || r.purged || r.error || r.alerts).forEach(r => console.log('maintenance', JSON.stringify(r))))
      .catch(error => console.error('maintenance failed', error));
  }, minutes * 60e3);
  timer.unref();
  return timer;
}

/**
 * Demo convenience (MOCK_IDP_AUTOCONFIGURE=1): point the default tenant's
 * SSO at the bundled mock IdP and invite alice@riverside.example as a
 * Riverside site manager, so the preview shows the whole SSO flow.
 */
async function autoconfigureMockSso(port) {
  const settings = (await store.tenantSettings(DEFAULT_TENANT)) || {};
  if (settings.sso) return;
  const issuer = `http://127.0.0.1:${port}/mock-idp`;
  // Demo only: the domain is marked verified (there is no real DNS for riverside.example).
  const at = new Date().toISOString();
  const sso = { issuer, clientId: 'accessx-demo', domains: ['riverside.example'], domainVerification: { 'riverside.example': { token: 'mock-autoconfigure', verifiedAt: at } }, enforced: false, trustUnverifiedEmail: false, clientSecretEnc: null, updatedAt: at };
  const t = store.tenant(DEFAULT_TENANT);
  const uow = t.unit().raw('UPDATE tenants SET settings = ? WHERE id = ?', [JSON.stringify({ ...settings, sso }), DEFAULT_TENANT])
    .audit('sso.configure', `issuer=${issuer} client=accessx-demo domains=riverside.example secret=none (mock autoconfigure)`, 'system');
  const snap = await t.snapshot();
  const river = snap.sites.find(x => /river/i.test(x.name)) || snap.sites[0];
  if (!(await t.operators()).some(o => o.email === 'alice@riverside.example')) {
    const { operatorStatement } = require('./store/repo');
    const crypto = require('node:crypto');
    const op = { id: 'op_alice', name: 'Alice Chen', role: 'r_manager', siteIds: river ? [river.id] : [], email: 'alice@riverside.example',
      tokenSha256: crypto.createHash('sha256').update(`unusable:${crypto.randomBytes(16).toString('hex')}`).digest('hex'), createdBy: 'system' };
    const stmt = operatorStatement(DEFAULT_TENANT, op);
    uow.raw(stmt.sql, stmt.params).audit('operator.create', `${op.id} role=r_manager sites=${op.siteIds.join(',')} auth=sso`, 'system');
  }
  await uow.commit();
  console.log(`SSO autoconfigured against the mock IdP (${issuer}); invited alice@riverside.example`);
}

module.exports = {
  writeQueue, app, api, store, dns, alerts, vendorFor, startReconciler, autoconfigureMockSso };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  api.whenReady().then(() => {
    startReconciler();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Access control server on ${PORT} — mode: ${tt.demo ? 'DEMO' : 'LIVE'} — db: ${path.join(DATA_DIR, 'accessx.sqlite')}`);
      if (process.env.MOCK_IDP === '1' && process.env.MOCK_IDP_AUTOCONFIGURE === '1') autoconfigureMockSso(PORT).catch(e => console.error('mock SSO autoconfigure failed:', e));
    });
  }).catch(error => { console.error('startup failed:', error); process.exit(1); });
}
