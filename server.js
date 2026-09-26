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

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data', 'runtime');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- storage ---------------- */
const sql = nodeSqliteAdapter(path.join(DATA_DIR, 'accessx.sqlite'));
migrateNode(sql, path.join(__dirname, 'migrations'));
const store = createStore(sql);

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

const auth = createAuthenticator({
  store,
  adminToken: process.env.ADMIN_TOKEN || '',
  operatorsJson: process.env.OPERATORS || '',
  platformToken: process.env.PLATFORM_TOKEN || '',
  openReads: process.env.AUTH_OPEN_READS === undefined ? tt.demo : process.env.AUTH_OPEN_READS === '1',
});
const api = createApi({
  store, auth, vendorFor, ensureReady, log: (...a) => console.error(...a),
  cookieSameSite: process.env.COOKIE_SAMESITE || 'Lax',
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
app.use(['/api', '/scim'], express.json({ limit: '64kb', type: ['application/json', 'application/scim+json'] }));
app.use(['/api', '/scim'], async (req, res) => {
  // NOTE: x-forwarded-for is client-controlled unless a trusted proxy
  // overwrites it. Behind a proxy, configure Express "trust proxy" instead.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  const out = await api.handle({
    method: req.method,
    path: req.originalUrl.split('?')[0],
    query: new URLSearchParams(req.originalUrl.split('?')[1] || ''),
    body: req.body,
    headers: req.headers,
    ip,
    secure: proto === 'https',
    origin: process.env.PUBLIC_URL || `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`,
  });
  for (const c of out.cookies || []) res.append('Set-Cookie', c);
  if (out.headers) res.set(out.headers);
  if (out.redirect) return res.redirect(302, out.redirect);
  if (out.body === null || out.body === undefined) return res.status(out.status).end();
  if (out.contentType) return res.status(out.status).type(out.contentType).send(JSON.stringify(out.body));
  return res.status(out.status).json(out.body);
});
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
      .then(results => results.filter(r => r.revoked || r.expired || r.pendingRemoval || r.failed || r.error)
        .forEach(r => console.log('reconcile', JSON.stringify(r))))
      .catch(error => console.error('reconcile failed', error));
  }, minutes * 60e3);
  timer.unref();
  return timer;
}

module.exports = { app, api, store, startReconciler };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  api.whenReady().then(() => {
    startReconciler();
    app.listen(PORT, '0.0.0.0', () => console.log(`Access control server on ${PORT} — mode: ${tt.demo ? 'DEMO' : 'LIVE'} — db: ${path.join(DATA_DIR, 'accessx.sqlite')}`));
  }).catch(error => { console.error('startup failed:', error); process.exit(1); });
}
