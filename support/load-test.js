#!/usr/bin/env node
/**
 * Load test (R20): one large tenant (200 doors, 5,000 people) plus 100 small
 * tenants, against the Node server (default: booted in-process) or a running
 * `wrangler dev` (BASE=http://127.0.0.1:8787).
 *
 *   node support/load-test.js                       # Node, in-process
 *   BASE=http://127.0.0.1:8787 NUKI_PORT=4002 node support/load-test.js   # Worker + local D1
 *
 * Env: DOORS=200 PEOPLE=5000 TENANTS=100 C=10 SAMPLES=20 MIX_SECONDS=20 OUT=/tmp/load.json
 *      OWNER=owner-token PLATFORM=platform-token
 * The doors come from a fake Nuki cloud started here (the Worker needs
 * NUKI_API_BASE=http://127.0.0.1:<NUKI_PORT> in .dev.vars). With USAGE_METER=1 on
 * the Worker, every sample also records its D1 cost (queries, rows read, rows
 * written), which is what docs/40-BILLING.md's cost model is built from.
 *
 * Phases
 *   1. setup: connect Nuki, sites, door groups (20 doors each), user groups, rules
 *   2. people: PEOPLE creates, C in flight (writes queue in the tenant's DO)
 *   3. per-endpoint: SAMPLES sequential calls each (latency + D1 cost)
 *   4. mixed: MIX_SECONDS of 80 % reads / 20 % writes, C in flight
 *   5. tenants: TENANTS small tenants (10 people each), then reads spread over all of them
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createFakeNuki } = require('./fake-nuki');

const DOORS = Number(process.env.DOORS || 200);
const PEOPLE = Number(process.env.PEOPLE || 5000);
const TENANTS = Number(process.env.TENANTS || 100);
const C = Number(process.env.C || 10);
const SAMPLES = Number(process.env.SAMPLES || 20);
const MIX_SECONDS = Number(process.env.MIX_SECONDS || 20);
const OWNER = process.env.OWNER || 'owner-token';
const PLATFORM = process.env.PLATFORM || 'platform-token';
const NUKI_TOKEN = 'load-test-nuki-token-0001';
const FIRST_LOCK = 30001;

let BASE = process.env.BASE || '';
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = x => (x === null ? null : Math.round(x * 10) / 10);

async function call(method, path, token, body) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  const m = /q=(\d+);read=(\d+);written=(\d+)/.exec(res.headers.get('x-accessx-d1') || '');
  return { status: res.status, body: json, ms, bytes: text.length, d1: m ? { q: +m[1], read: +m[2], written: +m[3] } : null };
}
async function must(method, path, token, body, ok = [200]) {
  const r = await call(method, path, token, body);
  if (!ok.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r;
}
/** Run `n` jobs with `c` in flight; returns latencies and statuses. */
async function pool(n, c, job, stop = () => false) {
  const lat = []; const statuses = {}; let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: Math.min(c, n) }, async () => {
    while (next < n && !stop()) {
      const i = next++;
      const r = await job(i);
      lat.push(r.ms); statuses[r.status] = (statuses[r.status] || 0) + 1;
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  n = Math.min(n, lat.length);
  return { n, c, seconds: r1(secs), perSecond: r1(n / secs), p50: r1(pct(lat, 50)), p95: r1(pct(lat, 95)), p99: r1(pct(lat, 99)), max: r1(Math.max(...lat)), statuses };
}
function summarize(name, rs) {
  const lat = rs.map(r => r.ms); const d = rs.filter(r => r.d1).map(r => r.d1);
  const avg = k => (d.length ? Math.round(d.reduce((s, x) => s + x[k], 0) / d.length) : null);
  return { name, n: rs.length, p50: r1(pct(lat, 50)), p95: r1(pct(lat, 95)), max: r1(Math.max(...lat)), kb: r1(rs.reduce((s, r) => s + r.bytes, 0) / rs.length / 1024), statuses: [...new Set(rs.map(r => r.status))].join(','), d1: d.length ? { q: avg('q'), read: avg('read'), written: avg('written') } : null };
}

(async () => {
  const locks = Object.fromEntries(Array.from({ length: DOORS }, (_, i) => [FIRST_LOCK + i, { name: `Door ${i + 1}`, batteryCharge: 50 + (i % 50) }]));
  const cloud = createFakeNuki({ accounts: { [NUKI_TOKEN]: { accountId: 90001, email: 'load@example.com', name: 'Load test', lockIds: Object.keys(locks).map(Number) } }, locks, confirmAfterGets: 0 });
  let api = null;
  if (!BASE) {
    const nukiBase = await cloud.listen(0);
    const { boot } = require('./boot');
    api = await boot({ ADMIN_TOKEN: OWNER, PLATFORM_TOKEN: PLATFORM, NUKI_API_BASE: nukiBase, NUKI_POLL_MS: '50', RECONCILE_INTERVAL_MIN: '0', SECRETS_KEY: crypto.randomBytes(32).toString('base64') });
    BASE = api.base;
  } else {
    await cloud.listen(Number(process.env.NUKI_PORT || 4002));
  }
  const runtime = api ? 'node' : 'worker';
  const out = { runtime, base: BASE, doors: DOORS, people: PEOPLE, tenants: TENANTS, c: C, at: new Date().toISOString(), phases: {} };
  const log = (...a) => console.log(...a);
  log(`load test on ${runtime} (${BASE}): ${DOORS} doors, ${PEOPLE} people, ${TENANTS} tenants, ${C} in flight`);

  try {
    // 1. setup
    const t0 = performance.now();
    const v = await call('PUT', '/api/vendor-account', OWNER, { kind: 'nuki', apiToken: NUKI_TOKEN });
    if (v.status !== 200) throw new Error(`connect Nuki: ${v.status} ${JSON.stringify(v.body)}`);
    const sites = [];
    for (let i = 0; i < 5; i++) sites.push((await must('POST', '/api/sites', OWNER, { name: `Load site ${i + 1}`, timezone: 'Europe/London' })).body.item.id);
    const doorGroups = [];
    for (let i = 0; i * 20 < DOORS; i++) {
      const lockIds = Object.keys(locks).map(Number).slice(i * 20, i * 20 + 20);
      doorGroups.push((await must('POST', '/api/doorGroups', OWNER, { name: `Doors ${i + 1}`, siteId: sites[i % sites.length], lockIds })).body.item);
    }
    const schedules = (await must('GET', '/api/schedules', OWNER)).body.schedules;
    const userGroups = [];
    for (let i = 0; i < 25; i++) userGroups.push((await must('POST', '/api/userGroups', OWNER, { name: `Team ${i + 1}`, siteId: sites[i % sites.length] })).body.item);
    for (const [i, g] of userGroups.entries()) {
      const mine = doorGroups.filter(d => d.siteId === g.siteId);
      for (const d of mine.slice(0, 2)) await must('POST', '/api/assignments', OWNER, { userGroupId: g.id, doorGroupId: d.id, scheduleId: schedules[i % schedules.length].id });
    }
    out.phases.setup = { seconds: r1((performance.now() - t0) / 1000), sites: sites.length, doorGroups: doorGroups.length, userGroups: userGroups.length };
    log('1. setup', JSON.stringify(out.phases.setup));

    // 2. people
    const created = [];
    out.phases.people = await pool(PEOPLE, C, async i => {
      const g = userGroups[i % userGroups.length]; const g2 = userGroups[(i * 7) % userGroups.length];
      const groupIds = i % 3 === 0 && g2.siteId === g.siteId && g2.id !== g.id ? [g.id, g2.id] : [g.id];
      const r = await call('POST', '/api/users', OWNER, { name: `Person ${i + 1}`, email: `p${i + 1}@load.example`, groupIds });
      if (r.status === 200) created.push(r.body.item.id);
      return r;
    });
    log('2. people', JSON.stringify(out.phases.people));

    // 3. per-endpoint, sequential
    const someone = created[Math.floor(created.length / 2)];
    const endpoints = [
      ['GET /api/doors', () => call('GET', '/api/doors', OWNER)],
      ['GET /api/users', () => call('GET', '/api/users', OWNER)],
      ['GET /api/compile', () => call('GET', '/api/compile', OWNER)],
      ['GET /api/users/:id/doors', () => call('GET', `/api/users/${someone}/doors`, OWNER)],
      ['GET /api/doors/health', () => call('GET', '/api/doors/health', OWNER)],
      ['GET /api/audit?limit=100', () => call('GET', '/api/audit?limit=100', OWNER)],
      ['GET /api/reports/revocation', () => call('GET', '/api/reports/revocation', OWNER)],
      ['POST /api/reconcile (dry run)', () => call('POST', '/api/reconcile', OWNER, { dryRun: true })],
      ['POST /api/users', () => call('POST', '/api/users', OWNER, { name: 'Sample person', groupIds: [userGroups[0].id] })],
    ];
    out.phases.endpoints = [];
    for (const [name, fn] of endpoints) {
      const rs = []; for (let i = 0; i < SAMPLES; i++) rs.push(await fn());
      out.phases.endpoints.push(summarize(name, rs));
    }
    // A code on a Nuki door and its revocation (vendor round trips included).
    const issue = []; const revoke = [];
    for (let i = 0; i < Math.min(SAMPLES, 10); i++) {
      const r = await call('POST', '/api/passcode', OWNER, { lockId: FIRST_LOCK + i, userId: someone, acknowledgeScheduleGap: true });
      issue.push(r);
      if (r.status === 200) revoke.push(await call('DELETE', `/api/credentials/${r.body.credential.id}`, OWNER, { reason: 'load test' }));
    }
    out.phases.endpoints.push(summarize('POST /api/passcode (Nuki)', issue), summarize('DELETE /api/credentials/:id (Nuki)', revoke));
    log('3. endpoints'); for (const e of out.phases.endpoints) log('  ', JSON.stringify(e));

    // 4. mixed load
    const reads = [() => call('GET', '/api/doors', OWNER), () => call('GET', '/api/users', OWNER), () => call('GET', '/api/compile', OWNER), () => call('GET', `/api/users/${someone}/doors`, OWNER)];
    const deadline = performance.now() + MIX_SECONDS * 1000;
    let k = 0;
    const mixed = await pool(1e9, C, async () => {
      k += 1;
      return k % 5 === 0 ? call('POST', '/api/users', OWNER, { name: `Mixed ${k}`, groupIds: [userGroups[k % userGroups.length].id] }) : reads[k % reads.length]();
    }, () => performance.now() > deadline);
    mixed.n = Object.values(mixed.statuses).reduce((s, x) => s + x, 0);
    out.phases.mixed = mixed;
    log('4. mixed', JSON.stringify(mixed));
  } finally {
    // Leave the default tenant as it was found (demo fleet): the data stays, the vendor goes.
    await call('DELETE', '/api/vendor-account', OWNER).catch(() => {});
  }

  // 5. many small tenants
  if (TENANTS > 0) {
    const tenants = [];
    const t = await pool(TENANTS, Math.min(C, 5), async i => {
      const r = await call('POST', '/api/tenants', PLATFORM, { name: `Load tenant ${i + 1}` });
      if (r.status === 200) tenants.push(r.body.owner.token);
      return r;
    });
    const seed = await pool(tenants.length * 10, C, async i => call('POST', '/api/users', tenants[i % tenants.length], { name: `Tenant person ${i}` }));
    const spread = await pool(tenants.length * 5, C, async i => call('GET', '/api/users', tenants[i % tenants.length]));
    const d1 = [];
    for (let i = 0; i < Math.min(10, tenants.length); i++) { const r = await call('GET', '/api/doors', tenants[i]); if (r.d1) d1.push(r.d1); }
    out.phases.tenants = { create: t, seedPeople: seed, readsAcrossTenants: spread, smallTenantDoorsD1: d1.length ? d1[d1.length - 1] : null };
    log('5. tenants', JSON.stringify(out.phases.tenants));
  }

  const file = process.env.OUT || `/tmp/load-${runtime}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  log(`written ${file}`);
  if (api) await api.close();
  await cloud.close();
  process.exit(0);
})().catch(e => { console.error('load test failed:', e); process.exit(1); });
