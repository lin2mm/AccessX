/**
 * RBAC core — shared by server.js (Express) and worker.js (Cloudflare).
 * ====================================================================
 * One route table decides which permission every API call needs.
 * Anything NOT listed here requires OWNER ('*'): new endpoints fail
 * closed until someone consciously grants them a permission.
 *
 * Operators (people who administer the system) are distinct from users
 * (people who open doors). An operator has one role and an optional
 * site scope. Tokens are never stored — only their SHA-256.
 */
const policy = require('./policy-core');

const PERMS = {
  'door.read': 'See doors, status and fleet health',
  'door.unlock': 'Remote-unlock a door (site-scoped)',
  'credential.issue': 'Issue passcodes / credentials (site-scoped)',
  'user.manage': 'Create and remove door users',
  'rule.manage': 'Edit sites, door groups, schedules, holidays and rules',
  'role.manage': 'Edit roles',
  'report.read': 'Run access reports, evaluate decisions, read records',
  'audit.read': 'Read and verify the audit trail',
  'mirror.sync': 'Pull records from the lock vendor',
  'diag.read': 'Installer diagnostics',
  'door.commission': 'Commission / decommission hardware',
};

const OWNER = '*';
const AUTHENTICATED = 'authenticated';
const PUBLIC = 'public';

const DEFAULT_ROLES = [
  { id: 'r_owner', name: 'Account Owner', perms: ['*'] },
  { id: 'r_manager', name: 'Site Manager', perms: ['door.read', 'door.unlock', 'credential.issue', 'user.manage', 'report.read', 'audit.read'] },
  { id: 'r_installer', name: 'Installer', perms: ['door.read', 'door.commission', 'diag.read'] },
  { id: 'r_view', name: 'Auditor', perms: ['door.read', 'report.read', 'audit.read'] },
];

/** What an anonymous visitor may do when open reads are enabled (demo mode). */
const PUBLIC_PERMS = ['door.read', 'report.read', 'audit.read'];

const COLLECTION_PERMS = {
  sites: 'rule.manage',
  doorGroups: 'rule.manage',
  userGroups: 'rule.manage',
  schedules: 'rule.manage',
  assignments: 'rule.manage',
  holidays: 'rule.manage',
  users: 'user.manage',
  roles: 'role.manage',
};

// [method, pattern, permission]. First match wins.
const ROUTES = [
  ['GET', /^\/api\/auth$/, PUBLIC],
  ['POST', /^\/api\/auth\/verify$/, AUTHENTICATED],
  ['GET', /^\/api\/me$/, AUTHENTICATED],
  ['GET', /^\/api\/(status|doors|vendor)$/, 'door.read'],
  ['GET', /^\/api\/health$/, 'door.read'],
  ['POST', /^\/api\/doors\/\d+\/unlock$/, 'door.unlock'],
  ['POST', /^\/api\/evaluate$/, 'report.read'],
  ['GET', /^\/api\/users\/[^/]+\/doors$/, 'report.read'],
  ['POST', /^\/api\/passcode$/, 'credential.issue'],
  ['GET', /^\/api\/credentials$/, 'report.read'],
  ['DELETE', /^\/api\/credentials\/[^/]+$/, 'credential.issue'],
  ['GET', /^\/api\/compile$/, 'report.read'],
  ['GET', /^\/api\/records\/\d+$/, 'report.read'],
  ['GET', /^\/api\/audit(\/verify)?$/, 'audit.read'],
  ['POST', /^\/api\/mirror\/sync$/, 'mirror.sync'],
  ['GET', /^\/api\/mirror\/(coverage|records)$/, 'report.read'],
  ['POST', /^\/api\/ai$/, 'report.read'],
  ['GET', /^\/api\/permissions$/, 'report.read'],
];

function requiredPermission(method, pathname) {
  const m = String(method || 'GET').toUpperCase() === 'HEAD' ? 'GET' : String(method || 'GET').toUpperCase();
  const path = String(pathname || '').replace(/\/+$/, '') || '/';
  for (const [routeMethod, pattern, perm] of ROUTES) {
    if (routeMethod === m && pattern.test(path)) return perm;
  }
  const collection = path.match(/^\/api\/([^/]+)(?:\/[^/]+)?$/);
  if (collection && COLLECTION_PERMS[collection[1]]) {
    if (m === 'GET' && !path.slice(5).includes('/')) return 'report.read';
    if (m === 'POST' || m === 'DELETE') return COLLECTION_PERMS[collection[1]];
  }
  return OWNER;
}

function roleFor(db, roleId) {
  const custom = ((db && db.roles) || []).find(role => role.id === roleId);
  return custom || DEFAULT_ROLES.find(role => role.id === roleId) || null;
}

function permsFor(db, operator) {
  if (!operator) return [];
  if (operator.anonymous) return PUBLIC_PERMS;
  if (operator.role === 'r_owner') return ['*']; // owner can never be locked out by a role edit
  const role = roleFor(db, operator.role);
  return role ? role.perms || [] : [];
}

function hasPermission(db, operator, perm) {
  if (perm === PUBLIC) return true;
  if (!operator) return false;
  if (perm === AUTHENTICATED) return !operator.anonymous;
  const perms = permsFor(db, operator);
  if (perms.includes('*')) return true;
  if (perm === OWNER) return false;
  return perms.includes(perm);
}

/** Site scope: undefined / [] / ['*'] = all sites. */
function allSites(operator) {
  const ids = operator && operator.siteIds;
  return !ids || !ids.length || ids.includes('*');
}

function canAccessSite(operator, siteId) {
  if (!operator) return false;
  if (allSites(operator)) return true;
  return Boolean(siteId) && operator.siteIds.includes(siteId);
}

/** Unassigned locks are visible only to all-site operators. */
function canAccessLock(db, operator, lockId) {
  const site = policy.siteForLock(db, lockId);
  return canAccessSite(operator, site && site.id);
}

function constantTimeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Parse the operator directory.
 *   OPERATORS='[{"id":"op_gym","name":"Gym manager","role":"r_manager",
 *               "siteIds":["site_gym"],"tokenSha256":"<hex>"}]'
 * ADMIN_TOKEN (if set) becomes an implicit owner.
 */
function parseOperators(json, adminTokenSha256) {
  let list = [];
  if (json) {
    try {
      list = JSON.parse(json);
    } catch {
      throw new Error('OPERATORS is not valid JSON');
    }
    if (!Array.isArray(list)) throw new Error('OPERATORS must be a JSON array');
  }
  const operators = list.map((op, index) => {
    if (!op || !/^[0-9a-f]{64}$/i.test(op.tokenSha256 || '')) {
      throw new Error(`OPERATORS[${index}] needs tokenSha256 (64 hex chars)`);
    }
    return {
      id: String(op.id || `op_${index}`),
      name: String(op.name || op.id || `Operator ${index}`),
      role: String(op.role || 'r_view'),
      siteIds: Array.isArray(op.siteIds) ? op.siteIds.map(String) : undefined,
      tokenSha256: op.tokenSha256.toLowerCase(),
    };
  });
  if (adminTokenSha256) {
    operators.unshift({ id: 'owner', name: 'Owner (ADMIN_TOKEN)', role: 'r_owner', tokenSha256: adminTokenSha256 });
  }
  return operators;
}

function findOperator(operators, tokenSha256) {
  let found = null;
  for (const op of operators) {
    // no early exit: compare against every entry
    if (constantTimeEqual(op.tokenSha256, tokenSha256) && !found) found = op;
  }
  return found;
}

const ANONYMOUS = Object.freeze({ id: 'anonymous', name: 'Anonymous (read-only)', role: 'public', anonymous: true });

function describe(db, operator) {
  if (!operator) return null;
  const role = operator.anonymous ? { name: 'Public read-only' } : roleFor(db, operator.role);
  return {
    id: operator.id,
    name: operator.name,
    role: operator.role,
    roleName: role ? role.name : operator.role,
    perms: permsFor(db, operator),
    siteIds: allSites(operator) ? ['*'] : operator.siteIds,
    anonymous: Boolean(operator.anonymous),
  };
}

module.exports = {
  PERMS, DEFAULT_ROLES, PUBLIC_PERMS, OWNER, AUTHENTICATED, PUBLIC, ANONYMOUS, ROUTES,
  requiredPermission, permsFor, hasPermission, canAccessSite, canAccessLock, allSites,
  parseOperators, findOperator, constantTimeEqual, describe, roleFor,
};
