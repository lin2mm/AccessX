// R17: replay the request sequences Okta and Microsoft Entra ID actually send (their published
// validators and docs), end to end, so a pilot's directory connects on the first try.
// Okta: "SCIM 2.0 Spec Test" (Okta's Runscope suite) + group push. Entra: the provisioning service,
// both the default (legacy PATCH) and the SCIM-compliant ?aadOptscim062020 behaviour
// (learn.microsoft.com/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility).
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');

const OWNER = 'owner-secret';
const SCIM_CT = 'application/scim+json';
const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const ENT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const patch = ops => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: ops });
const q = s => encodeURIComponent(s);

async function setup(t, name) {
  const ctx = await boot({ ADMIN_TOKEN: OWNER, RECONCILE_INTERVAL_MIN: '0' });
  t.after(ctx.close);
  const prov = await ctx.call('POST', '/api/operators', { token: OWNER, body: { name, role: 'r_provisioner' } });
  assert.equal(prov.status, 200);
  ctx.scim = (method, path, body) => ctx.call(method, `/scim/v2${path}`, { token: prov.body.token, body, contentType: SCIM_CT });
  return ctx;
}
const isError = (r, status) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.deepEqual(r.body.schemas, [ERR]);
  assert.equal(r.body.status, String(status));
  assert.equal(typeof r.body.detail, 'string');
};

test('Okta SCIM 2.0 spec test, in order', async t => {
  const ctx = await setup(t, 'Okta');
  const userName = `okta.spec.${Date.now().toString(36)}@harbour.example`;
  // 1. Paged list: ListResponse shape, 1-based startIndex.
  const first = await ctx.scim('GET', '/Users?count=1&startIndex=1');
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /application\/scim\+json/);
  assert.deepEqual(first.body.schemas, [LIST]);
  for (const k of ['totalResults', 'itemsPerPage', 'startIndex']) assert.equal(typeof first.body[k], 'number', k);
  assert.ok(Array.isArray(first.body.Resources));
  // 2. Unknown user: zero results, and Resources is still an array.
  const none = await ctx.scim('GET', `/Users?filter=${q(`userName eq "${userName}"`)}&startIndex=1&count=100`);
  assert.equal(none.body.totalResults, 0);
  assert.deepEqual(none.body.Resources, []);
  // 3. Create (Okta sends a password when "sync password" is on, and groups: []).
  const body = { schemas: [USER], userName, name: { givenName: 'Olive', familyName: 'Okta' }, emails: [{ primary: true, value: userName, type: 'work' }],
    displayName: 'Olive Okta', locale: 'en-US', externalId: '00u1abcd', groups: [], password: 'Sup3r-secret!', active: true };
  const created = await ctx.scim('POST', '/Users', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.id);
  assert.equal(created.body.active, true);
  assert.equal(created.body.userName, userName);
  assert.equal(JSON.stringify(created.body).includes('Sup3r'), false, 'a password is never stored or echoed');
  assert.ok(created.headers.get('location').endsWith(`/Users/${created.body.id}`));
  const id = created.body.id;
  // 4-5. Read back, by id and by filter.
  const got = await ctx.scim('GET', `/Users/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.userName, userName);
  assert.equal(got.body.meta.resourceType, 'User');
  assert.equal((await ctx.scim('GET', `/Users?filter=${q(`userName eq "${userName}"`)}`)).body.totalResults, 1);
  // 6. Duplicate: 409 uniqueness.
  const dup = await ctx.scim('POST', '/Users', body);
  isError(dup, 409);
  assert.equal(dup.body.scimType, 'uniqueness');
  // 7. Unknown id: 404 in the SCIM error format.
  isError(await ctx.scim('GET', '/Users/010101010101010101'), 404);
  // 8. userName filter is case-insensitive (RFC 7643 caseExact=false).
  assert.equal((await ctx.scim('GET', `/Users?filter=${q(`userName eq "${userName.toUpperCase()}"`)}`)).body.totalResults, 1);
  // Profile push: PUT with the whole user (id and password included).
  const put = await ctx.scim('PUT', `/Users/${id}`, { ...body, id, name: { givenName: 'Olivia', familyName: 'Okta' }, displayName: 'Olivia Okta' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.displayName, 'Olivia Okta');
  // 9. Deactivate / reactivate: path-less replace with {active}.
  const off = await ctx.scim('PATCH', `/Users/${id}`, patch([{ op: 'replace', value: { active: false } }]));
  assert.equal(off.status, 200);
  assert.equal(off.body.active, false);
  assert.equal((await ctx.scim('GET', `/Users/${id}`)).body.active, false);
  assert.equal((await ctx.scim('PATCH', `/Users/${id}`, patch([{ op: 'replace', value: { active: true } }]))).body.active, true);
  // Paging beyond the end: empty page, correct total.
  const total = (await ctx.scim('GET', '/Users')).body.totalResults;
  const past = await ctx.scim('GET', `/Users?startIndex=${total + 5}&count=10`);
  assert.equal(past.body.totalResults, total);
  assert.deepEqual(past.body.Resources, []);
  const zero = await ctx.scim('GET', '/Users?count=0');
  assert.equal(zero.body.totalResults, total);
  assert.equal(zero.body.itemsPerPage, 0);
});

test('Okta group push: create with members, rename with id in the value, add, remove by filter, delete', async t => {
  const ctx = await setup(t, 'Okta');
  const mk = async n => (await ctx.scim('POST', '/Users', { schemas: [USER], userName: `${n}@harbour.example`, name: { givenName: n, familyName: 'P' }, emails: [{ primary: true, value: `${n}@harbour.example`, type: 'work' }], active: true })).body.id;
  const a = await mk('ana'); const b = await mk('ben'); const c = await mk('cai');
  const g = await ctx.scim('POST', '/Groups', { schemas: [GROUP], displayName: 'Harbour Staff', members: [{ value: a, display: 'ana@harbour.example' }] });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const gid = g.body.id;
  const ren = await ctx.scim('PATCH', `/Groups/${gid}`, patch([{ op: 'replace', value: { id: gid, displayName: 'Harbour Everyone' } }]));
  assert.equal(ren.status, 200, JSON.stringify(ren.body));
  assert.equal(ren.body.displayName, 'Harbour Everyone');
  await ctx.scim('PATCH', `/Groups/${gid}`, patch([{ op: 'add', path: 'members', value: [{ value: b, display: 'ben' }, { value: c, display: 'cai' }] }]));
  await ctx.scim('PATCH', `/Groups/${gid}`, patch([{ op: 'remove', path: `members[value eq "${a}"]` }]));
  const now = await ctx.scim('GET', `/Groups/${gid}`);
  assert.deepEqual(now.body.members.map(m => m.value).sort(), [b, c].sort());
  // Okta checks the group by name before pushing.
  assert.equal((await ctx.scim('GET', `/Groups?filter=${q('displayName eq "Harbour Everyone"')}&startIndex=1&count=100`)).body.totalResults, 1);
  // Full replace (Okta "push now").
  const put = await ctx.scim('PUT', `/Groups/${gid}`, { schemas: [GROUP], id: gid, displayName: 'Harbour Everyone', members: [{ value: a }] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.members.map(m => m.value), [a]);
  assert.equal((await ctx.scim('DELETE', `/Groups/${gid}`)).status, 204);
  isError(await ctx.scim('GET', `/Groups/${gid}`), 404);
});

for (const mode of ['legacy', 'aadOptscim062020']) {
  test(`Entra ID provisioning sequence (${mode} PATCH behaviour)`, async t => {
    const ctx = await setup(t, 'Entra ID');
    const legacy = mode === 'legacy';
    const op = s => (legacy ? s[0].toUpperCase() + s.slice(1) : s);
    const upn = `ella.entra.${mode.length}@harbour.example`;
    // Match first: userName filter, then create.
    assert.equal((await ctx.scim('GET', `/Users?filter=${q(`userName eq "${upn}"`)}`)).body.totalResults, 0);
    const created = await ctx.scim('POST', '/Users', {
      schemas: [USER, ENT], externalId: 'ella', userName: upn, active: true, displayName: 'Ella Entra',
      name: { formatted: 'Ella Entra', familyName: 'Entra', givenName: 'Ella' },
      emails: [{ primary: true, type: 'work', value: upn }], title: 'Architect', preferredLanguage: 'en-AU',
      addresses: [{ type: 'work', formatted: '1 Harbour St', primary: true }], phoneNumbers: [{ type: 'mobile', value: '+61400000000' }],
      roles: [], [ENT]: { employeeNumber: '42', department: 'Design', manager: { value: 'boss' } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal(JSON.stringify(created.body).includes('+61400000000'), false, 'phone numbers are not kept');
    // Attribute updates: legacy = one op per attribute with capitalised ops; compliant = one path-less value map.
    const email2 = `ella.e.${mode.length}@harbour.example`;
    const upd = legacy
      ? patch([{ op: 'Replace', path: 'displayName', value: 'Ella E' }, { op: 'Replace', path: 'emails[type eq "work"].value', value: email2 },
        { op: 'Replace', path: 'name.givenName', value: 'Ella' }, { op: 'Replace', path: 'name.familyName', value: 'E' }, { op: 'Replace', path: 'externalId', value: 'ella2' },
        { op: 'Replace', path: `${ENT}:employeeNumber`, value: '43' }, { op: 'Add', path: 'nickName', value: 'Elle' },
        { op: 'Replace', path: 'addresses[type eq "work"].formatted', value: '2 Harbour St' }, { op: 'Add', path: `${ENT}:manager`, value: 'boss2' }])
      : patch([{ op: 'replace', path: 'emails[type eq "work"].value', value: email2 },
        { op: 'replace', value: { displayName: 'Ella E', 'name.givenName': 'Ella', 'name.familyName': 'E', [`${ENT}:employeeNumber`]: '43' } },
        { op: 'add', path: 'nickName', value: 'Elle' }]);
    const u = await ctx.scim('PATCH', `/Users/${id}`, upd);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.displayName, 'Ella E');
    assert.equal(u.body.emails[0].value, email2);
    // Groups: look up by name without members, create, add a member.
    assert.equal((await ctx.scim('GET', `/Groups?excludedAttributes=members&filter=${q('displayName eq "Design"')}`)).body.totalResults, 0);
    const g = await ctx.scim('POST', '/Groups', { schemas: [GROUP], externalId: 'grp-design', displayName: 'Design', members: [] });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    const found = await ctx.scim('GET', `/Groups?excludedAttributes=members&filter=${q('externalId eq "grp-design"')}`);
    assert.equal(found.body.totalResults, 1);
    assert.equal(found.body.Resources[0].members, undefined, 'excludedAttributes=members');
    await ctx.scim('PATCH', `/Groups/${g.body.id}`, patch([{ op: op('add'), path: 'members', value: [{ value: id }] }]));
    assert.deepEqual((await ctx.scim('GET', `/Groups/${g.body.id}`)).body.members.map(m => m.value), [id]);
    // Remove the member: legacy sends a value list, compliant a filter path.
    const rm = legacy ? patch([{ op: 'Remove', path: 'members', value: [{ value: id }] }]) : patch([{ op: 'remove', path: `members[value eq "${id}"]` }]);
    assert.equal((await ctx.scim('PATCH', `/Groups/${g.body.id}`, rm)).status, 200);
    assert.deepEqual((await ctx.scim('GET', `/Groups/${g.body.id}`)).body.members, []);
    // Disable: legacy "False" string, compliant boolean.
    const off = await ctx.scim('PATCH', `/Users/${id}`, patch([{ op: op('replace'), path: 'active', value: legacy ? 'False' : false }]));
    assert.equal(off.status, 200);
    assert.equal(off.body.active, false);
    // Soft-deleted users are re-enabled the same way.
    assert.equal((await ctx.scim('PATCH', `/Users/${id}`, patch([{ op: op('replace'), path: 'active', value: legacy ? 'True' : true }]))).body.active, true);
    // Hard delete (30 days after soft delete in Entra): 204, then 404, and a repeat is 404.
    assert.equal((await ctx.scim('DELETE', `/Users/${id}`)).status, 204);
    isError(await ctx.scim('GET', `/Users/${id}`), 404);
    isError(await ctx.scim('DELETE', `/Users/${id}`), 404);
  });
}

test('Entra and Okta edge cases: unsupported filters are 400 invalidFilter, bad JSON is 400, unknown ops rejected', async t => {
  const ctx = await setup(t, 'Entra ID');
  const f = await ctx.scim('GET', `/Users?filter=${q('userName sw "a"')}`);
  isError(f, 400);
  assert.equal(f.body.scimType, 'invalidFilter');
  const id = (await ctx.scim('POST', '/Users', { schemas: [USER], userName: 'edge@harbour.example', active: true })).body.id;
  isError(await ctx.scim('PATCH', `/Users/${id}`, patch([{ op: 'move', path: 'active', value: false }])), 400);
  isError(await ctx.scim('PATCH', `/Users/${id}`, { schemas: [] }), 400);
  isError(await ctx.scim('POST', '/Users', { schemas: [USER] }), 400);
  // Entra probes with a random filter before provisioning starts ("Test connection").
  const probe = await ctx.scim('GET', `/Users?filter=${q('userName eq "b4fa7c1e-0000-4000-8000-000000000000"')}`);
  assert.equal(probe.status, 200);
  assert.equal(probe.body.totalResults, 0);
});
