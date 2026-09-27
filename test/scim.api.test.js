const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');

const OWNER = 'owner-secret';
const SCIM_CT = 'application/scim+json';

async function setup(env = {}) {
  const ctx = await boot({ ADMIN_TOKEN: OWNER, ...env });
  const prov = await ctx.call('POST', '/api/operators', { token: OWNER, body: { name: 'Entra ID', role: 'r_provisioner' } });
  assert.equal(prov.status, 200);
  const token = prov.body.token;
  ctx.scim = (method, path, body) => ctx.call(method, `/scim/v2${path}`, { token, body, contentType: SCIM_CT });
  ctx.scimToken = token;
  return ctx;
}
const entraUser = (userName, extra = {}) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
  externalId: userName.split('@')[0], userName, active: true, displayName: userName.split('@')[0],
  name: { givenName: 'Given', familyName: 'Family', formatted: 'Given Family' },
  emails: [{ primary: true, type: 'work', value: userName }],
  title: 'Engineer', phoneNumbers: [{ type: 'mobile', value: '+61 400 000 000' }],
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'IT', manager: { value: 'x' } },
  ...extra,
});
const patch = ops => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: ops });

test('SCIM: discovery endpoints, auth and error format', async () => {
  const ctx = await setup();
  try {
    const spc = await ctx.scim('GET', '/ServiceProviderConfig');
    assert.equal(spc.status, 200);
    assert.match(spc.headers.get('content-type'), /application\/scim\+json/);
    assert.equal(spc.body.patch.supported, true);
    assert.equal(spc.body.bulk.supported, false);
    assert.equal((await ctx.scim('GET', '/ResourceTypes')).body.totalResults, 2);
    assert.equal((await ctx.scim('GET', '/Schemas')).body.Resources[0].id, 'urn:ietf:params:scim:schemas:core:2.0:User');

    const anon = await ctx.call('GET', '/scim/v2/Users');
    assert.equal(anon.status, 401);
    assert.deepEqual(anon.body.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
    assert.equal(anon.body.status, '401');
    // The owner's browser session must not reach SCIM (cookies ignored there).
    const login = await ctx.call('POST', '/api/auth/login', { body: { token: OWNER } });
    const cookie = login.cookies[0].split(';')[0];
    assert.equal((await ctx.call('GET', '/scim/v2/Users', { headers: { cookie } })).status, 401);
    // The provisioner token cannot use the normal API.
    assert.equal((await ctx.call('GET', '/api/users', { token: ctx.scimToken })).status, 403);
    assert.equal((await ctx.call('POST', '/api/doors/9001/unlock', { token: ctx.scimToken, body: { reason: 'x' } })).status, 403);
    const nf = await ctx.scim('GET', '/Users/nope');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.status, '404');
    assert.equal((await ctx.scim('GET', '/Users?filter=' + encodeURIComponent('title co "x"'))).body.scimType, 'invalidFilter');
  } finally { await ctx.close(); }
});

test('SCIM Users: Entra create/filter/patch quirks, data minimisation, uniqueness', async () => {
  const ctx = await setup();
  try {
    // Entra checks existence first.
    const probe = await ctx.scim('GET', '/Users?filter=' + encodeURIComponent('userName eq "Jane@Riverside.example"'));
    assert.equal(probe.body.totalResults, 0);
    const created = await ctx.scim('POST', '/Users', entraUser('jane@riverside.example'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.headers.get('location'), /\/scim\/v2\/Users\/usr_/);
    const id = created.body.id;
    assert.equal(created.body.active, true);
    assert.equal(created.body.emails[0].value, 'jane@riverside.example');
    // Case-insensitive userName filter; externalId filter is case-exact.
    assert.equal((await ctx.scim('GET', '/Users?filter=' + encodeURIComponent('userName eq "JANE@riverside.example"'))).body.totalResults, 1);
    assert.equal((await ctx.scim('GET', '/Users?filter=' + encodeURIComponent('externalId eq "jane"'))).body.totalResults, 1);
    assert.equal((await ctx.scim('GET', '/Users?filter=' + encodeURIComponent('externalId eq "JANE"'))).body.totalResults, 0);
    assert.equal((await ctx.scim('POST', '/Users', entraUser('JANE@riverside.example'))).status, 409);

    // Nothing beyond the minimal attributes is stored.
    const row = (await ctx.server.store.tenant('t_default').snapshot()).users.find(u => u.id === id);
    assert.ok(!JSON.stringify(row).includes('Engineer') && !JSON.stringify(row).includes('+61'), 'title/phone must not be stored');

    // Entra quirks: capitalised op, path-less value object, "False" as a string.
    const off = await ctx.scim('PATCH', `/Users/${id}`, patch([{ op: 'Replace', value: { active: 'False' } }]));
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.active, false);
    const renamed = await ctx.scim('PATCH', `/Users/${id}`, patch([
      { op: 'Replace', path: 'displayName', value: 'Jane Doe' },
      { op: 'Add', path: 'emails[type eq "work"].value', value: 'jane.doe@riverside.example' },
      { op: 'Replace', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'Ops' },
    ]));
    assert.equal(renamed.body.displayName, 'Jane Doe');
    assert.equal(renamed.body.emails[0].value, 'jane.doe@riverside.example');
    assert.equal((await ctx.scim('PATCH', `/Users/${id}`, patch([{ op: 'move', path: 'x' }]))).status, 400);
    assert.equal((await ctx.scim('PATCH', `/Users/${id}`, patch([{ op: 'replace', path: 'active', value: 'maybe' }]))).body.scimType, 'invalidValue');

    // PUT replaces.
    const put = await ctx.scim('PUT', `/Users/${id}`, entraUser('jane@riverside.example', { active: true, displayName: 'Jane D.' }));
    assert.equal(put.body.active, true);
    assert.equal(put.body.displayName, 'Jane D.');

    // Pagination.
    for (const n of [1, 2, 3]) await ctx.scim('POST', '/Users', entraUser(`p${n}@riverside.example`));
    const page = await ctx.scim('GET', '/Users?startIndex=2&count=2');
    assert.equal(page.body.totalResults, 4);
    assert.equal(page.body.itemsPerPage, 2);
    assert.equal(page.body.startIndex, 2);

    // Manual door users are invisible to the directory.
    assert.equal((await ctx.scim('GET', '/Users/u1')).status, 404);
    assert.equal((await ctx.scim('PATCH', '/Users/u1', patch([{ op: 'replace', path: 'active', value: false }]))).status, 404);

    // Audit carries ids only.
    const log = (await ctx.call('GET', '/api/audit?limit=100', { token: OWNER })).body.log;
    const scimEntries = log.filter(e => e.action.startsWith('scim.'));
    assert.ok(scimEntries.length >= 5);
    assert.ok(!scimEntries.some(e => /jane|riverside|Jane/.test(e.detail)), JSON.stringify(scimEntries.map(e => e.detail)));
  } finally { await ctx.close(); }
});

/** SSO with a DNS-verified domain (TXT answered by the resolver override). */
async function verifyDomain(ctx, domain) {
  const put = await ctx.call('PUT', '/api/sso', { token: OWNER, body: { issuer: `${ctx.base}/mock-idp`, clientId: 'accessx-test', domains: [domain] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const rec = put.body.sso.domainStatus.find(d => d.domain === domain).record;
  ctx.server.dns.set(rec.name, [rec.value]);
  const v = await ctx.call('POST', '/api/sso/domains/verify', { token: OWNER, body: { domain } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
}

test('SCIM: POST links an existing manual user by email only on a DNS-verified domain', async () => {
  const ctx = await setup({ MOCK_IDP: '1' });
  try {
    // Unverified domain: a directory must not be able to claim Dev by sending his address.
    const unverified = await ctx.scim('POST', '/Users', entraUser('dev@acme.co.uk'));
    assert.equal(unverified.status, 201);
    assert.notEqual(unverified.body.id, 'u2', 'not adopted');
    const log = (await ctx.call('GET', '/api/audit?action=scim.link_skipped', { token: OWNER })).body.log;
    assert.match(log[0].detail, /u2: email domain not verified/);
    assert.equal((await ctx.call('GET', '/api/users', { token: OWNER })).body.users.find(u => u.id === 'u2').source || 'manual', 'manual');
  } finally { await ctx.close(); }

  const ctx2 = await setup({ MOCK_IDP: '1' });
  try {
    await verifyDomain(ctx2, 'acme.co.uk');
    const linked = await ctx2.scim('POST', '/Users', entraUser('dev@acme.co.uk'));
    assert.equal(linked.status, 201);
    assert.equal(linked.body.id, 'u2', 'Dev Patel (manual) was adopted');
    const users = (await ctx2.call('GET', '/api/users', { token: OWNER })).body.users;
    assert.equal(users.filter(u => u.email === 'dev@acme.co.uk').length, 1);
    const dev = users.find(u => u.id === 'u2');
    assert.equal(dev.source, 'scim');
    assert.deepEqual(dev.groupIds, ['ug_staff', 'ug_it'], 'manual groups survive the link');
    assert.equal((await ctx2.call('DELETE', '/api/users/u2', { token: OWNER })).status, 409, 'directory-managed people are removed in the directory');
  } finally { await ctx2.close(); }
});

test('SCIM lifecycle: mapped group grants doors; deactivation revokes the code on the lock in the same request', async () => {
  const ctx = await setup();
  try {
    const u = (await ctx.scim('POST', '/Users', entraUser('kim@riverside.example'))).body;
    const g = await ctx.scim('POST', '/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'SG-Door-IT', externalId: 'aad-123', members: [] });
    assert.equal(g.status, 201);
    const add = await ctx.scim('PATCH', `/Groups/${g.body.id}`, patch([{ op: 'Add', path: 'members', value: [{ value: u.id }] }]));
    assert.equal(add.status, 200);
    assert.equal(add.body.members.length, 1);
    // Unmapped: no doors yet.
    assert.equal((await ctx.call('POST', '/api/passcode', { token: OWNER, body: { lockId: 9002, userId: u.id } })).status, 403);

    const map = await ctx.call('PUT', `/api/directory/groups/${g.body.id}`, { token: OWNER, body: { userGroupId: 'ug_it' } });
    assert.equal(map.status, 200, JSON.stringify(map.body));
    assert.equal(map.body.usersChanged, 1);
    const devAfter = (await ctx.call('GET', '/api/users', { token: OWNER })).body.users.find(x => x.id === 'u2');
    assert.ok(devAfter.groupIds.includes('ug_it'), 'mapping never strips manually managed members');
    const code = await ctx.call('POST', '/api/passcode', { token: OWNER, body: { lockId: 9002, userId: u.id } });
    assert.equal(code.status, 200, JSON.stringify(code.body));

    // Operator cannot undo a directory deactivation; directory cannot undo an operator suspension.
    const off = await ctx.scim('PATCH', `/Users/${u.id}`, patch([{ op: 'Replace', path: 'active', value: false }]));
    assert.equal(off.body.active, false);
    const creds = (await ctx.call('GET', '/api/credentials', { token: OWNER })).body.credentials.filter(c => c.userId === u.id);
    assert.equal(creds[0].status, 'revoked', 'reconciler removed the code during the SCIM request');
    const reinstate = await ctx.call('POST', `/api/users/${u.id}/unsuspend`, { token: OWNER });
    assert.equal(reinstate.status, 409);
    assert.equal(reinstate.body.managedBy, 'directory');

    await ctx.scim('PATCH', `/Users/${u.id}`, patch([{ op: 'Replace', path: 'active', value: true }]));
    const susp = await ctx.call('POST', `/api/users/${u.id}/suspend`, { token: OWNER });
    assert.equal(susp.status, 200, JSON.stringify(susp.body));
    await ctx.scim('PATCH', `/Users/${u.id}`, patch([{ op: 'Replace', path: 'active', value: 'True' }])); // routine re-sync
    const still = (await ctx.call('GET', '/api/users', { token: OWNER })).body.users.find(x => x.id === u.id);
    assert.equal(still.suspended, true, 'operator suspension survives a directory sync');

    const log = (await ctx.call('GET', '/api/audit?limit=50', { token: OWNER })).body.log.map(e => e.action);
    assert.ok(log.includes('scim.user_deactivate'));
    assert.ok(log.includes('credential.auto_revoke'), log.join(','));
    assert.ok(log.includes('directory.group_mapped'));
  } finally { await ctx.close(); }
});

test('SCIM Groups: removal paths (Okta filter, Entra value list), unmapping and group delete remove access', async () => {
  const ctx = await setup();
  try {
    const ids = [];
    for (const n of ['a', 'b', 'c']) ids.push((await ctx.scim('POST', '/Users', entraUser(`${n}@riverside.example`))).body.id);
    const g = (await ctx.scim('POST', '/Groups', { displayName: 'Door Staff', members: ids.map(value => ({ value })) })).body;
    await ctx.call('PUT', `/api/directory/groups/${g.id}`, { token: OWNER, body: { userGroupId: 'ug_staff' } });
    const groupsOf = async id => (await ctx.call('GET', '/api/users', { token: OWNER })).body.users.find(u => u.id === id).groupIds;
    assert.deepEqual(await groupsOf(ids[0]), ['ug_staff']);

    await ctx.scim('PATCH', `/Groups/${g.id}`, patch([{ op: 'remove', path: `members[value eq "${ids[0]}"]` }]));
    assert.deepEqual(await groupsOf(ids[0]), []);
    await ctx.scim('PATCH', `/Groups/${g.id}`, patch([{ op: 'Remove', path: 'members', value: [{ value: ids[1] }] }]));
    assert.deepEqual(await groupsOf(ids[1]), []);
    assert.deepEqual(await groupsOf(ids[2]), ['ug_staff']);
    const lean = await ctx.scim('GET', `/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "door staff"')}`);
    assert.equal(lean.body.totalResults, 1);
    assert.equal(lean.body.Resources[0].members, undefined);
    // Unknown member (e.g. another tenant's user id) is rejected.
    assert.equal((await ctx.scim('PATCH', `/Groups/${g.id}`, patch([{ op: 'add', path: 'members', value: [{ value: 'u1' }] }]))).status, 400);

    // Unmapping takes the user group away again.
    await ctx.call('PUT', `/api/directory/groups/${g.id}`, { token: OWNER, body: { userGroupId: null } });
    assert.deepEqual(await groupsOf(ids[2]), []);
    await ctx.call('PUT', `/api/directory/groups/${g.id}`, { token: OWNER, body: { userGroupId: 'ug_staff' } });
    assert.deepEqual(await groupsOf(ids[2]), ['ug_staff']);
    assert.equal((await ctx.scim('DELETE', `/Groups/${g.id}`)).status, 204);
    assert.deepEqual(await groupsOf(ids[2]), []);

    // Deleting a user erases them and drops them from groups.
    const g2 = (await ctx.scim('POST', '/Groups', { displayName: 'Other', members: [{ value: ids[2] }] })).body;
    assert.equal((await ctx.scim('DELETE', `/Users/${ids[2]}`)).status, 204);
    assert.equal((await ctx.scim('GET', `/Groups/${g2.id}`)).body.members.length, 0);
    assert.equal((await ctx.scim('GET', `/Users/${ids[2]}`)).status, 404);
    const dir = await ctx.call('GET', '/api/directory', { token: OWNER });
    assert.equal(dir.body.users.total, 2);
    assert.match(dir.body.scimBaseUrl, /\/scim\/v2$/);
  } finally { await ctx.close(); }
});

test('SCIM: parallel PATCHes to one group lose no members (optimistic concurrency)', async () => {
  const ctx = await setup();
  try {
    const ids = [];
    for (let n = 0; n < 15; n++) ids.push((await ctx.scim('POST', '/Users', entraUser(`c${n}@riverside.example`))).body.id);
    const g = (await ctx.scim('POST', '/Groups', { displayName: 'Burst' })).body;
    const results = await Promise.all(ids.map(id => ctx.scim('PATCH', `/Groups/${g.id}`, patch([{ op: 'Add', path: 'members', value: [{ value: id }] }]))));
    assert.deepEqual(results.map(r => r.status), ids.map(() => 200));
    const members = (await ctx.scim('GET', `/Groups/${g.id}`)).body.members.map(m => m.value).sort();
    assert.deepEqual(members, [...ids].sort());
  } finally { await ctx.close(); }
});
