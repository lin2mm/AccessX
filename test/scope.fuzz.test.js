/**
 * SITE-SCOPE GATE
 * ====================================================================
 * The isolation gate proves tenants cannot reach each other. This gate
 * proves the same inside one tenant: an operator scoped to ONE site, holding
 * EVERY permission through a custom role, calls every route in the route
 * table with other sites' ids — and with "mixed" bodies (their own group or
 * door group, other sites' doors and people inside), which is how a gym
 * admin once managed to file the office door under the gym.
 *
 * It fails if, afterwards, anything outside that operator's sites changed:
 * another site's rules, people, door groups, holidays; tenant-wide schedules
 * and roles; codes or visits on other sites' doors; other operators; tenant
 * settings; other sites' approvals — or if any new record reaches outside
 * the site. New routes are covered automatically.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');
const { scopeFor } = require('../api-core');
const rbac = require('../rbac-core');
const { SCHEMAS } = require('../validate-core');

const OWNER = 'owner-scope-secret';
const A = 't_default';
const SITE = 'site_gym';

function materialize(pattern, { ids, locks }) {
  let src = pattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
  const alt = src.match(/\(([a-z-]+(?:\|[a-z-]+)+)\)/);
  if (alt) return alt[1].split('|').flatMap(word => materialize(new RegExp(`^${src.replace(alt[0], word)}$`), { ids, locks }));
  const variants = [];
  if (src.includes('([^/]+)')) for (const id of ids) variants.push({ path: src.split('([^/]+)').join(encodeURIComponent(id)), id });
  else if (src.includes('(\\d+)')) for (const l of locks) variants.push({ path: src.split('(\\d+)').join(String(l)), id: String(l) });
  else variants.push({ path: src, id: null });
  for (const v of variants) if (/[()[\]\\^$*+?|{}]/.test(v.path)) throw new Error(`scope gate cannot materialize route ${pattern.source} — extend materialize()`);
  return variants;
}

test('site-scope gate: an all-permission operator scoped to one site cannot change anything outside it', async () => {
  const ctx = await boot({ ADMIN_TOKEN: OWNER, SECRETS_KEY: Buffer.alloc(32, 5).toString('base64'), AUTH_OPEN_READS: '0', RECONCILE_INTERVAL_MIN: '0', PUBLIC_URL: 'https://doors.example' });
  try {
    const call = ctx.call;
    const owner = { token: OWNER };
    const store = ctx.server.store;
    // Someone in a gym group AND an office group: visible to the gym
    // operator, but not theirs to change (the easiest case to get wrong).
    const s0 = await store.tenant(A).snapshot();
    const gymUg = s0.userGroups.find(g => g.siteId === SITE);
    const officeUg = s0.userGroups.find(g => g.siteId && g.siteId !== SITE);
    const both = (await call('POST', '/api/users', { ...owner, body: { name: 'Gym And Office Member', groupIds: [gymUg.id, officeUg.id] } })).body.item;
    assert.ok(both && both.id, 'a person with groups at two sites');
    // ---- state worth attacking: codes on other sites' doors, a sensitive
    // office door group with a pending approval, a visit at the office.
    await call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u2' } });
    await call('POST', '/api/doorGroups', { ...owner, body: { name: 'Office vault', siteId: 'site_river', lockIds: [9003], sensitive: true } });
    const pending = (await call('POST', '/api/passcode', { ...owner, body: { lockId: 9003, userId: 'u3', acknowledgeScheduleGap: true } })).body.approval;
    assert.ok(pending && pending.id, 'a pending approval on another site');
    const endLocal = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(Date.now() + 6 * 36e5)).replace(' ', 'T');
    const visit = (await call('POST', '/api/visits', { ...owner, body: { visitorName: 'Office Visitor', visitorEmail: 'v@guest.example', hostUserId: 'u1', lockIds: [9001], endLocal } })).body.visit;
    assert.ok(visit && visit.id);
    const role = (await call('POST', '/api/roles', { ...owner, body: { name: 'Everything, gym only', perms: Object.keys(rbac.PERMS) } })).body.item;
    assert.ok(role && role.id, 'custom role with every permission');
    const created = await call('POST', '/api/operators', { ...owner, body: { name: 'Gym superuser', role: role.id, siteIds: [SITE] } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const gym = { token: created.body.token };
    const gymOp = created.body.operator || { id: created.body.id, role: role.id, siteIds: [SITE] };

    // ---- the line: what this operator may write, judged on the state before
    const snap0 = await store.tenant(A).snapshot();
    const scope0 = scopeFor(snap0, { ...gymOp, role: role.id, siteIds: [SITE] });
    const inScopeLocks = new Set();
    const allLocks = [...new Set([9001, 9002, 9003, 9004, 9101, ...snap0.doorGroups.flatMap(g => g.lockIds || [])].map(Number))];
    for (const l of allLocks) if (scope0.lock(l)) inScopeLocks.add(l);
    const foreignLocks = allLocks.filter(l => !inScopeLocks.has(l));
    assert.ok(inScopeLocks.size >= 1 && foreignLocks.length >= 3, `gym doors ${[...inScopeLocks]}, others ${foreignLocks}`);
    const writable = (coll, item) => (coll === 'users' ? scope0.userManageable(item) : scope0.canWrite(coll, item));
    const COLLS = ['sites', 'doorGroups', 'userGroups', 'users', 'assignments', 'holidays', 'schedules', 'roles'];
    const own = coll => snap0[coll].filter(x => writable(coll, x)).map(x => x.id);
    const foreign = coll => snap0[coll].filter(x => !writable(coll, x))
      .sort((x, y) => (coll === 'users' ? Number(scope0.userVisible(y)) - Number(scope0.userVisible(x)) : 0)).map(x => x.id);
    const ops0 = await store.tenant(A).operators();
    const settings0 = await store.tenantSettings(A);
    const visits = () => store.sql.all('SELECT * FROM visits WHERE tenant_id = ? ORDER BY id', [A]);
    const approvals = () => store.sql.all('SELECT id, status, requested_by, decided_by FROM approvals WHERE tenant_id = ? ORDER BY id', [A]);
    const visits0 = await visits();
    const approvals0 = await approvals();

    const pick = (arr, n = 3) => arr.slice(0, n);
    const ids = [...new Set([
      ...COLLS.flatMap(c => [...pick(foreign(c)), ...pick(own(c), 2)]),
      ...snap0.credentials.map(c => c.id), ...ops0.map(o => o.id), pending.id, visit.id,
    ].filter(Boolean))];
    const fUsers = foreign('users'); const oUsers = own('users');
    const fUg = foreign('userGroups'); const oUg = own('userGroups');
    const fDg = foreign('doorGroups'); const oDg = own('doorGroups');
    const bodies = id => [
      // everything from other sites
      { userId: fUsers[0], hostUserId: fUsers[0], lockId: foreignLocks[0], lockIds: foreignLocks.slice(0, 2), userGroupId: fUg[0], groupIds: fUg.slice(0, 2),
        doorGroupId: fDg[0], siteId: 'site_river', siteIds: ['*'], role: 'r_owner', perms: ['*'], name: 'scope-fuzz', reason: 'scope-fuzz', sensitive: false,
        date: '2026-12-25', acknowledgeScheduleGap: true, visitorName: 'Fuzz', visitorEmail: 'fuzz@guest.example', endLocal, userIds: fUsers.slice(0, 2),
        scheduleId: snap0.schedules[0] && snap0.schedules[0].id, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }], suspended: false, id },
      // own containers, foreign contents
      { userId: oUsers[0] || fUsers[0], hostUserId: oUsers[0] || fUsers[0], lockId: foreignLocks[0], lockIds: [...inScopeLocks, ...foreignLocks.slice(0, 2)],
        userGroupId: oUg[0], groupIds: [oUg[0], fUg[0]].filter(Boolean), doorGroupId: oDg[0], siteId: SITE, siteIds: [SITE, 'site_river'], role: role.id,
        name: 'scope-fuzz-mixed', reason: 'scope-fuzz', sensitive: false, acknowledgeScheduleGap: true, visitorName: 'Fuzz', endLocal,
        userIds: [oUsers[0], fUsers[0]].filter(Boolean), windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }], id },
    ];

    const failures = [];
    let requests = 0;
    // Collection writes allow-list their fields (anything else is a 400
    // before scope is even checked), so they get bodies cut to their schema.
    const fieldsFor = (method, path) => {
      if (method === 'PATCH' && /^\/api\/doorGroups\//.test(path)) return ['name', 'lockIds', 'sensitive'];
      const coll = COLLS.find(c => new RegExp(`^/api/${c}(/|$)`).test(path));
      return coll && SCHEMAS[coll] ? Object.keys(SCHEMAS[coll]) : null;
    };
    const cut = (body, keys) => Object.fromEntries(Object.entries(body).filter(([k]) => keys.includes(k)));
    for (const r of ctx.server.api.routes) {
      for (const v of materialize(r.pattern, { ids, locks: allLocks })) {
        // Platform routes answer 401 to tenant tokens, and 401s trip the
        // failed-login brake, which would hide every route after them.
        if (/^\/api\/(tenants|platform)(\/|$)/.test(v.path)) continue;
        const keys = fieldsFor(r.method, v.path);
        const list = r.method === 'GET' || r.method === 'DELETE' ? [undefined] : bodies(v.id).map(b => (keys ? cut(b, keys) : b));
        for (const body of list) {
          const q = r.method === 'GET' ? `?userId=${fUsers[0]}&lockId=${foreignLocks[0]}` : '';
          const res = await call(r.method, v.path + q, { ...gym, body });
          requests++;
          if (res.status === 429) failures.push(`${r.method} ${v.path} → 429: the brake hid the rest of the run`);
          if (res.status >= 500 && res.status !== 501 && res.status !== 503) failures.push(`${r.method} ${v.path} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
        }
      }
    }

    // ---- nothing outside the site changed
    const snap1 = await store.tenant(A).snapshot();
    for (const coll of COLLS) {
      const after = new Map(snap1[coll].map(x => [x.id, x]));
      const before = new Map(snap0[coll].map(x => [x.id, x]));
      for (const id of foreign(coll)) {
        try { assert.deepEqual(after.get(id), before.get(id)); } catch { failures.push(`${coll} ${id} (outside the site) changed: ${JSON.stringify(after.get(id) || 'deleted').slice(0, 160)}`); }
      }
      for (const [id, x] of after) {
        const changed = !before.has(id) || JSON.stringify(before.get(id)) !== JSON.stringify(x);
        if (!changed) continue;
        if (!writable(coll, x)) failures.push(`${coll} ${id} was written but reaches outside the site: ${JSON.stringify(x).slice(0, 160)}`);
        if (coll === 'doorGroups' && (x.lockIds || []).some(l => !inScopeLocks.has(Number(l)))) failures.push(`door group ${id} now holds other sites' doors: ${x.lockIds}`);
      }
    }
    const creds0 = new Map(snap0.credentials.map(c => [c.id, c]));
    for (const c of snap1.credentials) {
      const was = creds0.get(c.id);
      if (!inScopeLocks.has(Number(c.lockId)) && JSON.stringify(was) !== JSON.stringify(c)) failures.push(`credential ${c.id} on door ${c.lockId} (other site) ${was ? 'changed' : 'was issued'}: ${c.status}`);
    }
    for (const c of snap0.credentials) if (!inScopeLocks.has(Number(c.lockId)) && !snap1.credentials.find(x => x.id === c.id)) failures.push(`credential ${c.id} on door ${c.lockId} disappeared`);
    const v0 = new Map(visits0.map(v => [v.id, v]));
    for (const v of await visits()) {
      const reachesOut = JSON.parse(v.lock_ids).some(l => !inScopeLocks.has(Number(l)));
      if (reachesOut && JSON.stringify(v0.get(v.id)) !== JSON.stringify(v)) failures.push(`visit ${v.id} at other sites' doors ${v.lock_ids} ${v0.has(v.id) ? `changed (${v.status})` : 'was created'}`);
    }
    const ops1 = await store.tenant(A).operators();
    for (const o of ops0) if (JSON.stringify(ops1.find(x => x.id === o.id)) !== JSON.stringify(o)) failures.push(`operator ${o.id} changed or was revoked`);
    for (const o of ops1.filter(x => !ops0.find(y => y.id === x.id))) {
      if (rbac.allSites(o) || (o.siteIds || []).some(s => s !== SITE)) failures.push(`new operator ${o.id} reaches sites ${JSON.stringify(o.siteIds)}`);
      if (o.role === 'r_owner') failures.push(`new operator ${o.id} is an owner`);
    }
    try { assert.deepEqual(await store.tenantSettings(A), settings0); } catch { failures.push('tenant settings changed'); }
    const ap1 = await approvals();
    for (const a of approvals0) if (JSON.stringify(ap1.find(x => x.id === a.id)) !== JSON.stringify(a)) failures.push(`approval ${a.id} (other site) was decided: ${JSON.stringify(ap1.find(x => x.id === a.id))}`);
    const log = (await call('GET', '/api/audit?limit=5000', owner)).body.log;
    for (const e of log.filter(x => x.actor === gymOp.id && /^unlock\.granted/.test(x.action))) {
      if (foreignLocks.some(l => new RegExp(`\\b${l}\\b`).test(e.detail))) failures.push(`remote unlock of another site's door: ${e.detail}`);
    }

    assert.deepEqual(failures, [], `${failures.length} scope failures:\n${failures.slice(0, 25).join('\n')}`);
    console.log(`# scope gate: ${requests} requests as an all-permission ${SITE} operator, ${foreignLocks.length} other-site doors, ${COLLS.reduce((n, c) => n + foreign(c).length, 0)} other-site records, 0 escapes`);
  } finally { await ctx.close(); }
});
