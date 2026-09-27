#!/usr/bin/env node
// Smoke-test a running Worker (wrangler dev) with the same RBAC scenarios
// as the Express tests. Usage:
//   BASE=http://127.0.0.1:8787 OWNER=owner-token GYM=gym-token AUDIT=audit-token PLATFORM=platform-token node support/worker-smoke.js
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const call = async (method, url, token, body) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
/** Lower-level call: headers, cookies, content type, no redirect following. */
const raw = async (method, url, { token, body, headers = {}, contentType = 'application/json', base = BASE } = {}) => {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = contentType;
  const res = await fetch(url.startsWith('http') ? url : base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers, cookies: res.headers.getSetCookie() };
};
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const { OWNER, GYM, AUDIT, PLATFORM } = process.env;

// R15: remember where the wrangler log ends now; any new "[ERROR]" line
// (console.error in the Worker, cron failures included) fails the run.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const wranglerLog = (() => {
  if (process.env.WRANGLER_LOG) return process.env.WRANGLER_LOG;
  const dir = path.join(os.homedir(), '.config', '.wrangler', 'logs');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.log')).map(f => path.join(dir, f));
    return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch { return null; }
})();
const logStart = wranglerLog && fs.existsSync(wranglerLog) ? fs.statSync(wranglerLog).size : 0;

// Fake email provider for the whole run (MAIL_PORT, with EMAIL_API_BASE pointing at it in .dev.vars):
// host notices from the kiosk and signup links land here instead of failing (a failure would be an [ERROR]).
const mail = [];
let mailServer = null;
async function startMail() {
  if (!process.env.MAIL_PORT) return;
  const http = require('node:http');
  mailServer = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { mail.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"e"}'); }); });
  await new Promise(r => mailServer.listen(Number(process.env.MAIL_PORT), '127.0.0.1', r));
}

check('public auth status', async () => {
  const r = await call('GET', '/api/auth');
  assert.equal(r.status, 200);
  assert.ok(r.body.operatorsConfigured >= 1);
});
check('anonymous may read doors (demo open reads)', async () => {
  assert.equal((await call('GET', '/api/doors')).status, 200);
});
check('anonymous cannot unlock', async () => {
  assert.equal((await call('POST', '/api/doors/9001/unlock', null, {})).status, 401);
});
check('gym manager sees only gym doors', async () => {
  const r = await call('GET', '/api/doors', GYM);
  assert.deepEqual(r.body.doors.map(d => d.lockId).sort(), [9101, 9102]);
});
check('gym manager cannot unlock office doors', async () => {
  assert.equal((await call('POST', '/api/doors/9002/unlock', GYM, {})).status, 403);
  assert.equal((await call('POST', '/api/doors/9101/unlock', GYM, { reason: 'delivery' })).status, 200);
});
check('operator override unlock requires a reason', async () => {
  assert.equal((await call('POST', '/api/doors/9101/unlock', GYM, {})).status, 400);
});
check('legacy D1 state was migrated into rows with its audit chain', async () => {
  const log = await call('GET', '/api/audit?limit=1000', OWNER);
  const seeded = log.body.log.find(e => e.action === 'tenant.seeded');
  assert.ok(seeded, 'tenant.seeded present');
  if (process.env.EXPECT_LEGACY) {
    assert.match(seeded.detail, /legacy app_state blob/);
    assert.ok(log.body.log.some(e => e.action === 'userGroups.site_inferred'));
    assert.ok(seeded.seq > Number(process.env.EXPECT_LEGACY));
  }
});
check('gym manager sees and manages only gym people', async () => {
  const r = await call('GET', '/api/users', GYM);
  assert.deepEqual(r.body.users.map(u => u.id), ['u4']);
  assert.equal((await call('POST', '/api/users/u1/suspend', GYM)).status, 404);
  assert.equal((await call('POST', '/api/users', GYM, { name: 'Office person', groupIds: ['ug_staff'] })).status, 403);
});
check('gym manager cannot edit rules', async () => {
  assert.equal((await call('POST', '/api/schedules', GYM, { name: 'x' })).status, 403);
});
check('auditor reads audit, cannot unlock', async () => {
  assert.equal((await call('GET', '/api/audit', AUDIT)).status, 200);
  assert.equal((await call('POST', '/api/doors/9001/unlock', AUDIT, {})).status, 403);
});
check('owner identity', async () => {
  const r = await call('GET', '/api/me', OWNER);
  assert.equal(r.body.operator.role, 'r_owner');
});
check('evaluate uses site time zone', async () => {
  const r = await call('POST', '/api/evaluate', OWNER, { userId: 'u1', lockId: 9001, localTime: '2026-07-01T08:30' });
  assert.equal(r.body.timeZone, 'Europe/London');
  assert.equal(r.body.result.allowed, true);
});
check('passcode requires a permitted person', async () => {
  assert.equal((await call('POST', '/api/passcode', OWNER, { lockId: 9002 })).status, 400);
  assert.equal((await call('POST', '/api/passcode', OWNER, { lockId: 9001, userId: 'u5' })).status, 403);
  assert.equal((await call('POST', '/api/passcode', OWNER, { lockId: 9001, userId: 'u1' })).status, 409);
  const r = await call('POST', '/api/passcode', OWNER, { lockId: 9002, userId: 'u2' });
  assert.equal(r.status, 200);
  assert.equal(r.body.credential.enforcement, 'lock');
});
check('gym manager cannot issue office passcodes', async () => {
  assert.equal((await call('POST', '/api/passcode', GYM, { lockId: 9002, userId: 'u2' })).status, 403);
});
check('credential registry and revoke', async () => {
  const list = await call('GET', '/api/credentials', OWNER);
  assert.ok(list.body.credentials.length >= 1);
  const active = list.body.credentials.find(c => c.status === 'active');
  const r = await call('DELETE', `/api/credentials/${active.id}`, OWNER);
  assert.equal(r.body.credential.status, 'revoked');
});
check('suspending a user auto-revokes their credentials', async () => {
  const issued = await call('POST', '/api/passcode', OWNER, { lockId: 9002, userId: 'u2' });
  assert.equal(issued.status, 200);
  const r = await call('POST', '/api/users/u2/suspend', OWNER);
  assert.equal(r.status, 200);
  assert.ok(r.body.reconcile.revoked >= 1, JSON.stringify(r.body.reconcile));
  const creds = await call('GET', '/api/credentials', OWNER);
  const c = creds.body.credentials.find(x => x.id === issued.body.credential.id);
  assert.equal(c.status, 'revoked');
  assert.equal(c.revokedBy, 'system:reconciler');
  assert.equal((await call('POST', '/api/users/u2/unsuspend', OWNER)).status, 200);
});
check('audit entries for people carry ids, never names or emails', async () => {
  const created = await call('POST', '/api/users', OWNER, { name: 'Zed Private', email: 'zed@private.example', groupIds: ['ug_staff'] });
  const log = await call('GET', '/api/audit?limit=5&action=users.create', OWNER);
  const entry = log.body.log.find(e => e.detail.startsWith(created.body.item.id));
  assert.ok(entry);
  assert.doesNotMatch(entry.detail, /Zed|zed@/);
  assert.equal((await call('DELETE', `/api/users/${created.body.item.id}`, OWNER)).status, 200);
});
check('platform creates an isolated tenant', async () => {
  if (!PLATFORM) return;
  assert.equal((await call('POST', '/api/tenants', OWNER, { name: 'x' })).status, 401);
  const t = await call('POST', '/api/tenants', PLATFORM, { name: 'Smoke Co' });
  assert.equal(t.status, 200);
  const token = t.body.owner.token;
  assert.deepEqual((await call('GET', '/api/users', token)).body.users, []);
  assert.deepEqual((await call('GET', '/api/doors', token)).body.doors, []);
  assert.equal((await call('DELETE', '/api/users/u1', token)).status, 404);
  assert.equal((await call('POST', '/api/doors/9001/unlock', token, { reason: 'try' })).status, 404);
  assert.equal((await call('POST', '/api/passcode', token, { lockId: 9001, userId: 'u1' })).status, 404);
  assert.equal((await call('GET', '/api/records/9001', token)).status, 404);
  const audit = await call('GET', '/api/audit', token);
  assert.ok(audit.body.log.every(e => e.seq <= 3));
  assert.equal((await call('GET', '/api/audit/verify', token)).body.verification.ok, true);
  assert.equal((await call('GET', '/api/tenants', token)).status, 401);
});
check('cron reconcile runs', async () => {
  const res = await fetch(`${BASE}/cdn-cgi/local/scheduled`);
  assert.equal(res.status, 200);
});
check('audit chain verifies and records operators', async () => {
  const v = await call('GET', '/api/audit/verify', OWNER);
  assert.equal(v.body.verification.ok, true, JSON.stringify(v.body.verification));
  assert.ok(v.body.verification.count > 5);
  const log = await call('GET', '/api/audit?limit=5', OWNER);
  assert.equal(log.body.log.length, 5);
  assert.ok(log.body.log[0].seq > log.body.log[1].seq);
  assert.ok(log.body.log.some(e => e.actor === 'owner'));
});
check('validation rejects malformed records', async () => {
  const r = await call('POST', '/api/schedules', OWNER, { name: 'Broken', windows: [{ from: '09:00' }] });
  assert.equal(r.status, 400);
  assert.equal((await call('DELETE', '/api/schedules/sch_office', OWNER)).status, 409);
});
check('copilot output escapes stored names', async () => {
  await call('POST', '/api/users', OWNER, { name: '<img src=x onerror=alert(1)>', groupIds: ['ug_it'], suspended: true });
  const r = await call('POST', '/api/ai', OWNER, { q: 'anything unusual?' });
  assert.equal(r.body.answer.includes('<img src=x'), false);
});
check('static assets carry a strict CSP', async () => {
  const res = await fetch(BASE + '/');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self';/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
check('policy compiler reports enforcement levels', async () => {
  const r = await call('GET', '/api/compile', OWNER);
  assert.equal(r.status, 200);
  assert.equal(r.body.summary.rules, 9);
  assert.ok(r.body.summary.cloud >= 1 && r.body.summary.lock >= 1);
  const gym = await call('GET', '/api/compile', GYM);
  assert.ok(gym.body.locks.every(l => [9101, 9102].includes(l.lockId)));
});
check('browser session: HttpOnly cookie, CSRF required for writes, logout', async () => {
  const login = await raw('POST', '/api/auth/login', { body: { token: OWNER } });
  assert.equal(login.status, 200);
  const set = login.cookies.find(c => /ax_session=/.test(c));
  assert.match(set, /HttpOnly/);
  const cookie = set.split(';')[0];
  assert.equal((await raw('GET', '/api/auth/session', { headers: { cookie } })).body.authenticated, true);
  assert.equal((await raw('POST', '/api/reconcile', { headers: { cookie }, body: {} })).status, 403, 'no CSRF token');
  assert.equal((await raw('POST', '/api/reconcile', { headers: { cookie, 'x-csrf-token': login.body.csrf }, body: {} })).status, 200);
  await raw('POST', '/api/auth/logout', { headers: { cookie, 'x-csrf-token': login.body.csrf }, body: {} });
  assert.equal((await raw('GET', '/api/me', { headers: { cookie } })).status, 401);
});
check('SCIM on D1: deactivation revokes the code; parallel PATCHes lose nothing', async () => {
  const prov = (await call('POST', '/api/operators', OWNER, { name: 'Smoke Entra', role: 'r_provisioner' })).body.token;
  const scim = (m, u, b) => raw(m, `/scim/v2${u}`, { token: prov, body: b, contentType: 'application/scim+json' });
  const stamp = Date.now().toString(36);
  const u = await scim('POST', '/Users', { userName: `smoke-${stamp}@riverside.example`, displayName: 'Smoke User', active: true });
  assert.equal(u.status, 201, JSON.stringify(u.body));
  assert.match(u.headers.get('content-type'), /scim\+json/);
  const g = (await scim('POST', '/Groups', { displayName: `SG-Smoke-${stamp}`, members: [{ value: u.body.id }] })).body;
  assert.equal((await call('PUT', `/api/directory/groups/${g.id}`, OWNER, { userGroupId: 'ug_it' })).status, 200);
  const code = await call('POST', '/api/passcode', OWNER, { lockId: 9002, userId: u.body.id });
  assert.equal(code.status, 200, JSON.stringify(code.body));
  const off = await scim('PATCH', `/Users/${u.body.id}`, { Operations: [{ op: 'Replace', value: { active: 'False' } }] });
  assert.equal(off.body.active, false);
  const cred = (await call('GET', '/api/credentials', OWNER)).body.credentials.find(c => c.id === code.body.credential.id);
  assert.equal(cred.status, 'revoked');
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push((await scim('POST', '/Users', { userName: `burst-${stamp}-${i}@riverside.example` })).body.id);
  const burst = (await scim('POST', '/Groups', { displayName: `SG-Burst-${stamp}` })).body;
  const res = await Promise.all(ids.map(id => scim('PATCH', `/Groups/${burst.id}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: id }] }] })));
  assert.deepEqual(res.map(r => r.status), ids.map(() => 200));
  assert.equal((await scim('GET', `/Groups/${burst.id}`)).body.members.length, 8);
  assert.equal((await raw('GET', '/scim/v2/Users', { token: GYM })).status, 403, 'a manager token is not a SCIM token');
});
check('time-to-revoke report on D1', async () => {
  const r = await call('GET', '/api/reports/revocation?days=7', OWNER);
  assert.equal(r.status, 200);
  assert.ok(r.body.remote.count >= 1, JSON.stringify(r.body.remote));
});
if (process.env.IDP) {
  check('SSO on the Worker against an external IdP (mock)', async () => {
    const put = await raw('PUT', '/api/sso', { token: OWNER, body: { issuer: `${process.env.IDP}/mock-idp`, clientId: 'worker-smoke', clientSecret: 'smoke-secret', domains: ['riverside.example'] } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.sso.hasClientSecret, true);
    const email = `alice@riverside.example`;
    const ops = (await call('GET', '/api/operators', OWNER)).body.operators;
    if (!ops.some(o => o.email === email && !o.revokedAt)) {
      assert.equal((await call('POST', '/api/operators', OWNER, { name: 'Alice', role: 'r_manager', siteIds: ['site_river'], email, auth: 'sso' })).status, 200);
    }
    const start = await raw('GET', `/api/auth/sso/start?email=${email}`);
    assert.equal(start.status, 302);
    const flow = start.cookies.find(c => /ax_sso=/.test(c)).split(';')[0];
    // The mock advertises a relative authorize endpoint (same-origin demo); here it lives elsewhere.
    const sent = new URL(start.headers.get('location'), BASE);
    const loc = new URL(sent.pathname + sent.search, process.env.IDP);
    loc.searchParams.set('user', 'mock|alice');
    const idp = await fetch(loc, { redirect: 'manual' });
    const cb = new URL(idp.headers.get('location'));
    const done = await raw('GET', cb.pathname + cb.search, { headers: { cookie: flow } });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/', done.headers.get('location'));
    const cookie = done.cookies.find(c => /ax_session=[^;]/.test(c)).split(';')[0];
    const me = await raw('GET', '/api/auth/session', { headers: { cookie } });
    assert.equal(me.body.via, 'sso');
    assert.deepEqual(me.body.operator.siteIds, ['site_river']);
  });
}
check('writes run in the tenant Durable Object (serialized), reads do not', async () => {
  const w = await raw('POST', '/api/reconcile', { token: OWNER, body: { dryRun: true } });
  assert.equal(w.status, 200);
  assert.equal(w.headers.get('x-accessx-writer'), 'durable-object');
  const r = await raw('GET', '/api/users', { token: OWNER });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-accessx-writer'), null);
  const bad = await raw('POST', '/api/reconcile', { token: 'nope', body: {} });
  assert.equal(bad.status, 401, 'unknown credentials are rejected at the edge, never reach a DO');
  assert.equal(bad.headers.get('x-accessx-writer'), null);
});
check('self-service signup: emailed link → new tenant + owner (or cleanly off)', async () => {
  const info = await call('GET', '/api/signup');
  assert.equal(info.status, 200);
  if (!info.body.enabled || !process.env.MAIL_PORT) {
    if (!info.body.enabled) assert.equal((await call('POST', '/api/signup', null, { company: 'X', name: 'Y', email: 'y@x.example', acceptTerms: true })).status, 404);
    console.log('     (signup round trip skipped: needs SIGNUP_ENABLED=1, EMAIL_API_BASE=http://127.0.0.1:$MAIL_PORT and MAIL_PORT)');
    return;
  }
  const got = mail;
  const before = mail.length;
  {
    const email = `smoke-${Date.now().toString(36)}@harbour.example`;
    const r = await raw('POST', '/api/signup', { body: { company: 'Smoke Harbour', name: 'Smoke Owner', email, timeZone: 'Australia/Sydney', acceptTerms: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(got.length, before + 1);
    const token = (got[before].text.match(/#t=([A-Za-z0-9_-]+)/) || [])[1];
    const v = await raw('POST', '/api/signup/verify', { body: { token } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const me = await call('GET', '/api/me', v.body.owner.token);
    assert.equal(me.body.tenant.id, v.body.tenant.id);
    assert.equal((await call('GET', '/api/users', v.body.owner.token)).body.users.length, 0);
    assert.equal((await raw('POST', '/api/signup/verify', { body: { token } })).status, 410);
    const list = await call('GET', '/api/platform/signups', PLATFORM);
    assert.equal(list.body.signups.recent[0].tenantId, v.body.tenant.id);
  }
});
check('front-desk kiosk on D1: pair, phone pass, check-in (host told), walk-in → code, sign-out', async () => {
  const pairRes = await call('POST', '/api/kiosks', OWNER, { siteId: 'site_river', name: 'Smoke reception' });
  assert.equal(pairRes.status, 200, JSON.stringify(pairRes.body));
  const key = pairRes.body.pairUrl.match(/#k=(kx_[A-Za-z0-9_-]+)$/)[1];
  const k = (body) => raw('POST', '/api/kiosk', { body });
  assert.equal((await call('GET', '/api/visits', key)).status, 401, 'a kiosk key is not an operator');
  const info = await k({ kiosk: key, action: 'pass' });
  assert.equal(info.status, 200, JSON.stringify(info.body));
  assert.equal(info.body.site, 'Riverside Office');
  assert.equal((await k({ pass: info.body.pass, action: 'info' })).body.mode, 'phone');
  // A visit ending 4 hours from now, door time (Europe/London).
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(Date.now() + 4 * 3600e3)).map(x => [x.type, x.value]));
  const email = `kiosk-${Date.now().toString(36)}@guest.example`;
  const v = await call('POST', '/api/visits', OWNER, { visitorName: 'Kiosk Smoke', visitorEmail: email, hostUserId: 'u1', lockIds: [9001], endLocal: `${p.year}-${p.month}-${p.day}T${p.hour}:00` });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const mailBefore = mail.length;
  const ci = await k({ pass: info.body.pass, action: 'checkin', email, acceptNotice: true });
  assert.equal(ci.status, 200, JSON.stringify(ci.body));
  if (mailServer) assert.equal(mail.length, mailBefore + 1, 'host emailed');
  const w = await k({ kiosk: key, action: 'walkin', name: 'Walk Smoke', host: 'Sarah Kelly' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const wl = (await call('GET', '/api/walkins', OWNER)).body.walkins.find(x => x.name === 'Walk Smoke');
  const issued = await call('POST', '/api/visits', OWNER, { visitorName: 'Walk Smoke', hostUserId: 'u1', lockIds: [9001], endLocal: `${p.year}-${p.month}-${p.day}T${p.hour}:00`, walkinId: wl.id });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.ok(issued.body.visit.checkedInAt);
  const out = await k({ kiosk: key, action: 'checkout', email });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((await call('POST', `/api/kiosks/${pairRes.body.kiosk.id}/revoke`, OWNER, {})).status, 200);
  assert.equal((await k({ kiosk: key, action: 'info' })).status, 401);
  assert.equal((await k({ pass: info.body.pass, action: 'info' })).status, 401);
});
check('demo reset through the tenant Durable Object restores the seed and keeps the audit chain', async () => {
  const before = (await call('GET', '/api/audit/verify', OWNER)).body.verification;
  assert.equal((await call('POST', '/api/platform/tenants/t_default/demo-reset', PLATFORM, {})).status, 400);
  const r = await raw('POST', '/api/platform/tenants/t_default/demo-reset', { token: PLATFORM, body: { confirm: 't_default' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const users = (await call('GET', '/api/users', OWNER)).body.users;
  assert.equal(users.length, r.body.reset.counts.users);
  assert.ok(!users.some(u => u.name.startsWith('<img')), 'smoke-created users are gone');
  const after = (await call('GET', '/api/audit/verify', OWNER)).body.verification;
  assert.equal(after.ok, true);
  assert.ok(after.count > before.count);
});
check('wrong token is rejected', async () => {
  assert.equal((await call('GET', '/api/me', 'nope')).status, 401);
});

(async () => {
  await startMail();
  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log(`ok   ${name}`); } catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message}`); }
  }
  let logFailed = false;
  if (wranglerLog && fs.existsSync(wranglerLog)) {
    await new Promise(r => setTimeout(r, 500)); // let wrangler flush
    const fd = fs.openSync(wranglerLog, 'r');
    const size = fs.statSync(wranglerLog).size;
    const buf = Buffer.alloc(Math.max(0, size - logStart));
    fs.readSync(fd, buf, 0, buf.length, logStart);
    fs.closeSync(fd);
    const errors = buf.toString('utf8').split('\n').filter(l => /\[ERROR\]/.test(l));
    if (errors.length) { logFailed = true; console.log(`FAIL wrangler log has ${errors.length} new [ERROR] line(s) (${wranglerLog}):\n     ${errors.slice(0, 5).join('\n     ')}`); }
    else console.log(`ok   wrangler log: no new [ERROR] lines (${path.basename(wranglerLog)})`);
  } else console.log('     (wrangler log not found: set WRANGLER_LOG to check it for errors)');
  console.log(`${checks.length - failed}/${checks.length} passed`);
  if (mailServer) mailServer.close();
  process.exit(failed || logFailed ? 1 : 0);
})();
