const assert = require('node:assert/strict');
const test = require('node:test');
const rbac = require('./rbac-core');

const db = {
  sites: [{ id: 'site_a' }, { id: 'site_b' }],
  doorGroups: [
    { id: 'dg_a', siteId: 'site_a', lockIds: [1] },
    { id: 'dg_b', siteId: 'site_b', lockIds: [2] },
  ],
  roles: rbac.DEFAULT_ROLES,
};
const hex = c => c.repeat(64);

test('every route resolves to a permission; unknown routes require owner', () => {
  assert.equal(rbac.requiredPermission('GET', '/api/auth'), rbac.PUBLIC);
  assert.equal(rbac.requiredPermission('GET', '/api/doors'), 'door.read');
  assert.equal(rbac.requiredPermission('HEAD', '/api/doors'), 'door.read');
  assert.equal(rbac.requiredPermission('POST', '/api/doors/9001/unlock'), 'door.unlock');
  assert.equal(rbac.requiredPermission('POST', '/api/passcode'), 'credential.issue');
  assert.equal(rbac.requiredPermission('GET', '/api/users'), 'report.read');
  assert.equal(rbac.requiredPermission('POST', '/api/users'), 'user.manage');
  assert.equal(rbac.requiredPermission('DELETE', '/api/schedules/x'), 'rule.manage');
  assert.equal(rbac.requiredPermission('POST', '/api/roles'), 'role.manage');
  assert.equal(rbac.requiredPermission('PUT', '/api/users/u1'), rbac.OWNER);
  assert.equal(rbac.requiredPermission('POST', '/api/something-new'), rbac.OWNER);
  assert.equal(rbac.requiredPermission('GET', '/api/users/u1'), rbac.OWNER);
});

test('roles grant exactly their permissions; owner has everything', () => {
  const manager = { id: 'm', role: 'r_manager' };
  const auditor = { id: 'a', role: 'r_view' };
  const owner = { id: 'o', role: 'r_owner' };
  assert.equal(rbac.hasPermission(db, manager, 'door.unlock'), true);
  assert.equal(rbac.hasPermission(db, manager, 'rule.manage'), false);
  assert.equal(rbac.hasPermission(db, auditor, 'door.unlock'), false);
  assert.equal(rbac.hasPermission(db, auditor, 'audit.read'), true);
  assert.equal(rbac.hasPermission(db, owner, rbac.OWNER), true);
  assert.equal(rbac.hasPermission(db, { id: 'x', role: 'r_missing' }, 'door.read'), false);
});

test('owner cannot be demoted by editing the roles collection', () => {
  const edited = { ...db, roles: [{ id: 'r_owner', name: 'Owner', perms: [] }] };
  assert.equal(rbac.hasPermission(edited, { id: 'o', role: 'r_owner' }, 'role.manage'), true);
});

test('anonymous visitors only get public read permissions', () => {
  assert.equal(rbac.hasPermission(db, rbac.ANONYMOUS, 'door.read'), true);
  assert.equal(rbac.hasPermission(db, rbac.ANONYMOUS, 'door.unlock'), false);
  assert.equal(rbac.hasPermission(db, rbac.ANONYMOUS, rbac.AUTHENTICATED), false);
});

test('site scope limits which locks an operator can touch', () => {
  const scoped = { id: 'm', role: 'r_manager', siteIds: ['site_a'] };
  const global = { id: 'g', role: 'r_manager' };
  assert.equal(rbac.canAccessLock(db, scoped, 1), true);
  assert.equal(rbac.canAccessLock(db, scoped, 2), false);
  assert.equal(rbac.canAccessLock(db, scoped, 999), false); // unassigned lock
  assert.equal(rbac.canAccessLock(db, global, 999), true);
});

test('operator directory validation', () => {
  assert.throws(() => rbac.parseOperators('not json'), /valid JSON/);
  assert.throws(() => rbac.parseOperators('[{"id":"x"}]'), /tokenSha256/);
  const ops = rbac.parseOperators(JSON.stringify([{ id: 'm', role: 'r_manager', tokenSha256: hex('a') }]), hex('b'));
  assert.equal(ops[0].id, 'owner');
  assert.equal(rbac.findOperator(ops, hex('a')).id, 'm');
  assert.equal(rbac.findOperator(ops, hex('c')), null);
});
