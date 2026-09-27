/**
 * CROSS-TENANT ISOLATION GATE
 * ====================================================================
 * Every route in the API's own route table (plus SCIM and the session
 * routes) is called with tenant B's credentials — owner bearer token,
 * owner browser session, and B's SCIM token — using tenant A's ids in
 * the path and the body. The gate fails if:
 *   1. any response contains data that only exists in tenant A, or
 *   2. anything in tenant A changed (snapshot, audit head, operators,
 *      settings, sessions), or
 *   3. B managed to perform a successful action on A's ids.
 * New routes are covered automatically. A route whose pattern cannot be
 * turned into a concrete URL fails the gate, so nobody can add an
 * endpoint that silently escapes it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');

const OWNER_A = 'owner-a-secret';
const PLATFORM = 'platform-secret';
const SCIM_CT = 'application/scim+json';
const A = 't_default';

function materialize(pattern, { ids, locks }) {
  let src = pattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
  // Alternations of plain words, e.g. (approve|reject|cancel): try every one.
  const alt = src.match(/\(([a-z-]+(?:\|[a-z-]+)+)\)/);
  if (alt) return alt[1].split('|').flatMap(word => materialize(new RegExp(`^${src.replace(alt[0], word)}$`), { ids, locks }));
  const variants = [];
  if (src.includes('([^/]+)')) for (const id of ids) variants.push({ path: src.split('([^/]+)').join(encodeURIComponent(id)), id });
  else if (src.includes('(\\d+)')) for (const l of locks) variants.push({ path: src.split('(\\d+)').join(String(l)), id: String(l) });
  else variants.push({ path: src, id: null });
  for (const v of variants) {
    if (/[()[\]\\^$*+?|{}]/.test(v.path)) throw new Error(`isolation gate cannot materialize route ${pattern.source} — extend materialize()`);
  }
  return variants;
}

function poisonedBody(id, a) {
  return {
    userId: a.userIds.includes(id) ? id : a.userIds[0], lockId: 9001, lockIds: [9001, 9002],
    userGroupId: a.userGroupIds.includes(id) ? id : a.userGroupIds[0], groupIds: a.userGroupIds.slice(0, 2),
    doorGroupId: a.doorGroupIds[0], scheduleId: a.scheduleIds[0], siteId: a.siteIds[0], siteIds: a.siteIds.slice(0, 1),
    name: 'fuzz', reason: 'fuzz', role: 'r_manager', email: 'fuzz@b-tenant.example', date: '2026-12-25',
    q: `why can ${a.userIds[0]} open 9001`, acknowledgeScheduleGap: true, at: '2026-10-05T10:00:00Z',
    issuer: `${a.base}/mock-idp`, clientId: 'b-client', domains: ['riverside.example'],
  };
}

test('cross-tenant isolation gate: tenant B cannot read or change tenant A through any route', async () => {
  const ctx = await boot({ ADMIN_TOKEN: OWNER_A, PLATFORM_TOKEN: PLATFORM, MOCK_IDP: '1', SECRETS_KEY: Buffer.alloc(32, 3).toString('base64'), AUTH_OPEN_READS: '0' });
  try {
    const call = ctx.call;
    const ownerA = { token: OWNER_A };
    // ---- tenant A: rich state (credentials, SCIM people/groups, SSO, operators, custom role)
    await call('POST', '/api/passcode', { ...ownerA, body: { lockId: 9002, userId: 'u2' } });
    await call('POST', '/api/passcode', { ...ownerA, body: { lockId: 9004, userId: 'u3', acknowledgeScheduleGap: true } });
    await call('POST', '/api/roles', { ...ownerA, body: { name: 'A Night Guard Role', perms: ['door.read'] } });
    await call('PUT', '/api/sso', { ...ownerA, body: { issuer: `${ctx.base}/mock-idp`, clientId: 'tenant-a-client-7731', clientSecret: 'tenant-a-sso-secret', domains: ['riverside.example'] } });
    await call('POST', '/api/operators', { ...ownerA, body: { name: 'A Invited Manager', role: 'r_manager', siteIds: ['site_river'], email: 'a.manager@riverside.example', auth: 'sso' } });
    const provA = (await call('POST', '/api/operators', { ...ownerA, body: { name: 'A Entra', role: 'r_provisioner' } })).body.token;
    const scimA = (m, p, b) => call(m, `/scim/v2${p}`, { token: provA, body: b, contentType: SCIM_CT });
    const su = (await scimA('POST', '/Users', { userName: 'zoe.a-only@riverside.example', displayName: 'Zoe Tenant-A-Only', active: true })).body;
    const sg = (await scimA('POST', '/Groups', { displayName: 'SG-TenantA-Secret-Group', members: [{ value: su.id }] })).body;
    await call('PUT', `/api/directory/groups/${sg.id}`, { ...ownerA, body: { userGroupId: 'ug_it' } });
    await call('POST', '/api/users/u4/suspend', ownerA);
    // A pending four-eyes request (sensitive door group around lock 9003).
    await call('POST', '/api/doorGroups', { ...ownerA, body: { name: 'A Vault Sensitive Doors', siteId: 'site_river', lockIds: [9003], sensitive: true } });
    const aprA = (await call('POST', '/api/passcode', { ...ownerA, body: { lockId: 9003, userId: 'u3', acknowledgeScheduleGap: true } })).body.approval;
    assert.ok(aprA && aprA.id, 'tenant A has a pending approval');
    // A visitor (personal data outside the snapshot, in the visits table).
    const endLocal = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(Date.now() + 6 * 36e5)).replace(' ', 'T');
    const visA = (await call('POST', '/api/visits', { ...ownerA, body: { visitorName: 'Wanda Tenant-A-Visitor', visitorEmail: 'wanda.a-only@guest.example', company: 'A-Only Visiting Co', hostUserId: 'u1', lockIds: [9001], endLocal } })).body;
    assert.ok(visA.visit && visA.visit.id, JSON.stringify(visA));
    const loginA = await call('POST', '/api/auth/login', { body: { token: OWNER_A } });
    const cookieA = loginA.cookies[0].split(';')[0];

    // ---- tenant B
    const tb = await call('POST', '/api/tenants', { token: PLATFORM, body: { name: 'Tenant B Pty' } });
    assert.equal(tb.status, 200);
    const ownerB = tb.body.owner.token;
    const provB = (await call('POST', '/api/operators', { token: ownerB, body: { name: 'B Okta', role: 'r_provisioner' } })).body.token;
    const loginB = await call('POST', '/api/auth/login', { body: { token: ownerB } });
    const cookieB = loginB.cookies[0].split(';')[0];
    const csrfB = loginB.body.csrf;
    await call('POST', '/scim/v2/Groups', { token: provB, body: { displayName: 'B group' }, contentType: SCIM_CT });

    // ---- what "A-only" looks like
    const store = ctx.server.store;
    const snapA0 = await store.tenant(A).snapshot();
    const headA0 = await store.tenant(A).auditHead();
    const opsA0 = await store.tenant(A).operators();
    const settingsA0 = await store.tenantSettings(A);
    const visitsA = () => store.sql.all('SELECT * FROM visits WHERE tenant_id = ? ORDER BY id', [A]);
    const visitsA0 = await visitsA();
    const bJson = JSON.stringify(await store.tenant(tb.body.tenant.id).snapshot()) + JSON.stringify(await store.tenant(tb.body.tenant.id).operators());
    const strings = new Set();
    const collect = v => {
      if (typeof v === 'string') { if (v.length >= 5 && !/^\d+$/.test(v) && !/^\d{4}-\d{2}-\d{2}/.test(v)) strings.add(v); }
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (!['timezone', 'windows', 'perms', 'status', 'enforcement', 'type', 'source', 'directoryStatus', 'suspendedBy', 'role', 'revokedBy', 'issuedBy', 'createdBy', 'revokeReason', 'rules', 'validFrom', 'validTo', 'startAt', 'endAt', 'issuedAt', 'revokedAt', 'createdAt', 'updatedAt'].includes(k)) collect(x); });
    };
    collect(snapA0.users); collect(snapA0.userGroups); collect(snapA0.doorGroups); collect(snapA0.sites); collect(snapA0.schedules);
    collect(snapA0.assignments); collect(snapA0.holidays); collect(snapA0.roles); collect(snapA0.credentials); collect(snapA0.directoryGroups);
    collect(opsA0.map(o => ({ id: o.id, name: o.name, email: o.email })));
    strings.add('tenant-a-client-7731'); strings.add('tenant-a-sso-secret'); strings.add(aprA.id);
    for (const x of [visA.visit.id, 'Wanda Tenant-A-Visitor', 'wanda.a-only@guest.example', 'A-Only Visiting Co', ...visA.codes.map(c => c.code)]) strings.add(x);
    const markers = [...strings].filter(s => !bJson.includes(s));
    assert.ok(markers.length > 60, `expected plenty of A-only markers, got ${markers.length}`);

    const pick = (arr, n = 3) => arr.slice(0, n);
    const a = {
      base: ctx.base,
      userIds: snapA0.users.map(u => u.id), userGroupIds: snapA0.userGroups.map(g => g.id), doorGroupIds: snapA0.doorGroups.map(g => g.id),
      scheduleIds: snapA0.schedules.map(s => s.id), siteIds: snapA0.sites.map(s => s.id),
    };
    const ids = [...new Set([
      ...pick(a.userIds, 4), su.id, ...pick(a.userGroupIds), ...pick(a.doorGroupIds), ...pick(a.siteIds), ...pick(a.scheduleIds),
      ...pick(snapA0.assignments.map(x => x.id)), ...pick(snapA0.holidays.map(x => x.id).filter(Boolean)), ...snapA0.roles.map(r => r.id).filter(id => !/^r_(owner|manager|installer|view|provisioner)$/.test(id)),
      ...snapA0.credentials.map(c => c.id), sg.id, ...opsA0.map(o => o.id), aprA.id, visA.visit.id,
    ])];
    const locks = [9001, 9002, 9004, 9101];

    const auths = {
      'B owner (bearer)': { token: ownerB },
      'B owner (session)': { headers: { cookie: cookieB, 'x-csrf-token': csrfB } },
      'B SCIM token': { token: provB },
    };
    const leaks = [];
    let requests = 0;
    const check = (label, method, url, body, res) => {
      requests++;
      const sent = url + JSON.stringify(body || {});
      const text = JSON.stringify(res.body) + (res.headers.get('location') || '');
      for (const m of markers) if (text.includes(m) && !sent.includes(m)) leaks.push(`${label} ${method} ${url} → ${res.status} leaked "${m}"`);
      if (res.status >= 500 && res.status !== 501) leaks.push(`${label} ${method} ${url} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
    };

    // ---- 1) every route in the table
    for (const r of ctx.server.api.routes) {
      for (const v of materialize(r.pattern, { ids, locks })) {
        for (const [label, auth] of Object.entries(auths)) {
          const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : poisonedBody(v.id, a);
          const q = r.method === 'GET' ? `?userId=${a.userIds[0]}&lockId=9001&actor=${opsA0[0].id}` : '';
          const res = await call(r.method, v.path + q, { ...auth, body });
          check(label, r.method, v.path + q, body, res);
        }
      }
    }
    // ---- 2) SCIM, with A's people/group ids and A's userName in filters
    const scimTargets = [['Users', su.id], ['Groups', sg.id], ['Users', 'u1']];
    for (const [label, auth] of [['B SCIM token', { token: provB }], ['B owner (bearer)', { token: ownerB }]]) {
      for (const [kind, id] of scimTargets) {
        for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
          const body = method === 'PATCH' ? { Operations: [{ op: 'replace', path: 'active', value: false }, { op: 'add', path: 'members', value: [{ value: su.id }] }] }
            : method === 'PUT' ? { userName: 'x@b.example', displayName: 'x', members: [{ value: su.id }] } : undefined;
          const url = `/scim/v2/${kind}/${id}`;
          check(label, method, url, body, await call(method, url, { ...auth, body, contentType: SCIM_CT }));
        }
      }
      for (const url of [`/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${su.userName}"`)}`, `/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "SG-TenantA-Secret-Group"')}`, '/scim/v2/Users', '/scim/v2/Groups']) {
        const res = await call('GET', url, { ...auth, contentType: SCIM_CT });
        check(label, 'GET', url, null, res);
        if (res.status === 200 && url.includes('filter')) assert.equal(res.body.totalResults, 0, `${label} ${url}`);
      }
      const body = { displayName: `B steals ${label}`, members: [{ value: su.id }] };
      const stolen = await call('POST', '/scim/v2/Groups', { ...auth, body, contentType: SCIM_CT });
      check(label, 'POST', '/scim/v2/Groups', body, stolen);
      assert.equal(stolen.status, 400, 'A user ids are unknown members in B');
    }
    // ---- 3) session routes
    for (const [label, auth] of Object.entries(auths)) {
      check(label, 'GET', '/api/auth/session', null, await call('GET', '/api/auth/session', auth));
    }

    assert.deepEqual(leaks, [], `${leaks.length} isolation failures:\n${leaks.slice(0, 20).join('\n')}`);

    // ---- A is untouched
    assert.deepEqual(await store.tenant(A).snapshot(), snapA0, 'tenant A data changed');
    assert.deepEqual(await store.tenant(A).auditHead(), headA0, 'tenant A audit chain changed');
    assert.deepEqual(await store.tenant(A).operators(), opsA0, 'tenant A operators changed');
    assert.deepEqual(await store.tenantSettings(A), settingsA0, 'tenant A settings changed');
    assert.deepEqual(await visitsA(), visitsA0, 'tenant A visits changed');
    assert.equal((await call('GET', '/api/me', { headers: { cookie: cookieA } })).status, 200, "tenant A's session was ended");
    assert.equal((await scimA('GET', `/Users/${su.id}`)).status, 200);
    // ---- B never succeeded at anything on A's ids
    const bLog = (await call('GET', '/api/audit?limit=1000', { token: ownerB })).body.log;
    const aIds = new Set([...ids, ...locks.map(String)]);
    const bad = bLog.filter(e => /^(unlock\.granted|passcode\.create|credential\.|visit\.|users\.(suspend|unsuspend|delete)|scim\.|directory\.|operator\.revoke)/.test(e.action)
      && [...aIds].some(id => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(e.detail)));
    assert.deepEqual(bad.map(e => `${e.action} ${e.detail}`), []);
    console.log(`# isolation gate: ${requests} requests, ${ctx.server.api.routes.length} routes + SCIM + session, ${markers.length} A-only markers, 0 leaks`);
  } finally { await ctx.close(); }
});
