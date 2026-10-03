/**
 * RBAC coverage gate. Every API route must be classified on purpose:
 *  - no route may fall through to the fail-closed default (add a rule in
 *    rbac-core.js ROUTES, even if it is OWNER);
 *  - no rule may be stale (match no route);
 *  - every permission must be used by some route (or be listed as reserved);
 *  - anonymous demo reads stay limited to read permissions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');
const rbac = require('../rbac-core');

// Paths served outside the route table (session/SSO handlers, SCIM).
const OUTSIDE_ROUTE_TABLE = [/^\/api\/auth(\/|$)/, /^\/scim\//];
// Permissions that exist for roles but have no API route yet.
const RESERVED_PERMS = new Set(['door.commission', 'diag.read']);

/** A concrete path for a route pattern: ids → "x1", lock ids → 9001, alternations → each word. */
function samples(pattern) {
  let src = pattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
  src = src.replace(/\(\/verify\)\?/, '');
  const alt = src.match(/\(([a-z-]+(?:\|[a-z-]+)+)\)/);
  const variants = alt ? alt[1].split('|').map(w => src.replace(alt[0], w)) : [src];
  return variants.map(v => v.replace(/\(\[\^\/\]\+\)/g, 'x1').replace(/\(\\d\+\)/g, '9001'));
}

test('RBAC coverage: every route is classified explicitly, no rule is stale, every permission is used', async t => {
  const api = await boot({ ADMIN_TOKEN: 'o' });
  t.after(api.close);
  const routes = api.server.api.routes;
  const unclassified = [];
  const usedRules = new Set();
  const usedPerms = new Set();
  for (const r of routes) {
    for (const path of samples(r.pattern)) {
      assert.ok(!/[()[\]\\^$*+?|{}]/.test(path), `cannot build a sample path for ${r.method} ${r.pattern} — extend samples()`);
      const res = rbac.resolvePermission(r.method, path);
      if (res.source === 'default') unclassified.push(`${r.method} ${path}`);
      if (res.rule) usedRules.add(res.rule);
      usedPerms.add(res.perm);
    }
  }
  assert.deepEqual(unclassified, [], `routes without an explicit RBAC rule (add them to ROUTES in rbac-core.js):\n  ${unclassified.join('\n  ')}`);

  const stale = rbac.ROUTES.filter(rule => !usedRules.has(rule) && !OUTSIDE_ROUTE_TABLE.some(re => re.test(samples(rule[1])[0])))
    .map(([m, p]) => `${m} ${p}`);
  assert.deepEqual(stale, [], `RBAC rules that match no route:\n  ${stale.join('\n  ')}`);

  const unused = Object.keys(rbac.PERMS).filter(p => !usedPerms.has(p) && !RESERVED_PERMS.has(p) && p !== 'directory.sync');
  assert.deepEqual(unused, [], `permissions no route uses: ${unused.join(', ')}`);
  for (const p of RESERVED_PERMS) assert.ok(!usedPerms.has(p), `${p} is now used — remove it from RESERVED_PERMS`);

  // Demo mode: anonymous visitors only ever get read permissions.
  assert.deepEqual([...rbac.PUBLIC_PERMS].sort(), ['audit.read', 'door.read', 'report.read']);
  const anonWrites = routes.filter(r => r.method !== 'GET').flatMap(r => samples(r.pattern).map(p => [r.method, p]))
    .filter(([m, p]) => rbac.PUBLIC_PERMS.includes(rbac.requiredPermission(m, p)))
    .map(([m, p]) => `${m} ${p}`);
  assert.deepEqual(anonWrites, ['POST /api/evaluate', 'POST /api/ai'], 'the only non-GET routes open to demo visitors are read-only computations');
});
