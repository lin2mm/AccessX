/**
 * Authentication — shared by server.js and worker.js (no Node/Web APIs).
 * ====================================================================
 * Bearer token → operator → tenant. Tokens are never stored; only their
 * SHA-256. Three sources, checked in order:
 *   1. ADMIN_TOKEN            → owner of the default tenant (bootstrap)
 *   2. OPERATORS (env JSON)   → bootstrap operators (default tenant unless tenantId set)
 *   3. operators table        → created via POST /api/operators, revocable
 * PLATFORM_TOKEN is separate: it can create tenants and nothing else.
 *
 * Returns { operator, tenantId } or { error: { status, body } }.
 */
const rbac = require('./rbac-core');
const { sha256Hex } = require('./audit-core');

const DEFAULT_TENANT = 't_default';
const MAX_FAILS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function createAuthenticator({
  store,
  adminToken = '',
  operatorsJson = '',
  platformToken = '',
  openReads = false,
  defaultTenant = DEFAULT_TENANT,
  maxFails = MAX_FAILS,
  windowMs = WINDOW_MS,
} = {}) {
  const directory = rbac.parseOperators(operatorsJson, adminToken ? sha256Hex(adminToken) : '')
    .map(op => ({ ...op, tenantId: op.tenantId || defaultTenant, source: 'env' }));
  const platformHash = platformToken ? sha256Hex(platformToken) : '';
  const failures = new Map();

  function noteFail(ip) {
    const entry = failures.get(ip);
    if (!entry || Date.now() > entry.resetAt) failures.set(ip, { count: 1, resetAt: Date.now() + windowMs });
    else entry.count++;
    if (failures.size > 10000) failures.clear(); // bound memory under a spray attack
    return failures.get(ip).count;
  }

  const err = (status, error, extra = {}) => ({ error: { status, body: { ok: false, error, ...extra } } });

  async function anyCredentialConfigured() {
    if (directory.length) return true;
    return Boolean(await store.sql.first('SELECT 1 AS x FROM operators WHERE revoked_at IS NULL LIMIT 1'));
  }

  async function authenticate({ method, path, authorization = '', ip = 'unknown' }) {
    const perm = rbac.requiredPermission(method, path);
    if (perm === rbac.PUBLIC) return { operator: null, tenantId: defaultTenant, perm };

    const match = String(authorization).match(/^Bearer\s+(.+)$/i);
    if (!match) {
      if (openReads && perm !== rbac.PLATFORM && rbac.hasPermission(null, rbac.ANONYMOUS, perm)) {
        return { operator: rbac.ANONYMOUS, tenantId: defaultTenant, perm };
      }
      if (!(await anyCredentialConfigured()) && perm !== rbac.PLATFORM) {
        const isRead = method === 'GET' || method === 'HEAD';
        return err(503, isRead
          ? 'API access is disabled until ADMIN_TOKEN or OPERATORS is configured.'
          : 'Writes are disabled until ADMIN_TOKEN or OPERATORS is configured.');
      }
      return err(401, 'unauthorized');
    }

    const failed = failures.get(ip);
    if (failed && Date.now() > failed.resetAt) failures.delete(ip);

    const hash = sha256Hex(match[1].trim());
    if (perm === rbac.PLATFORM) {
      if (platformHash && rbac.findOperator([{ tokenSha256: platformHash }], hash)) {
        failures.delete(ip);
        return { operator: { id: 'platform', name: 'Platform operator', platform: true }, tenantId: null, perm };
      }
      if (noteFail(ip) >= maxFails) return err(429, 'too many failed auth attempts, try later');
      return err(platformHash ? 401 : 404, platformHash ? 'unauthorized' : 'not found');
    }

    const operator = rbac.findOperator(directory, hash) || (await store.operatorByTokenHash(hash));
    if (!operator) {
      if (noteFail(ip) >= maxFails) return err(429, 'too many failed auth attempts, try later');
      return err(401, 'unauthorized');
    }
    failures.delete(ip);
    const { tokenSha256, ...safe } = operator; // never let the hash travel further
    return { operator: safe, tenantId: operator.tenantId, perm };
  }

  function status() {
    return {
      mode: directory.length ? 'TOKEN' : openReads ? 'DEMO-READ-ONLY' : 'LOCKED',
      tokenConfigured: Boolean(adminToken),
      operatorsConfigured: directory.length,
      openReads,
      writesRequireToken: true,
      multiTenant: Boolean(platformHash),
    };
  }

  /** Bootstrap (env) operators of one tenant, without hashes. */
  function envOperators(tenantId) {
    return directory.filter(op => op.tenantId === tenantId)
      .map(({ id, name, role, siteIds }) => ({ id, name, role, siteIds, source: 'env (bootstrap)' }));
  }

  return { authenticate, status, envOperators, defaultTenant };
}

module.exports = { createAuthenticator, DEFAULT_TENANT };
