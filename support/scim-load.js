#!/usr/bin/env node
/**
 * SCIM load test — what an IdP's first full sync of a mid-size customer does.
 *
 *   BASE=http://127.0.0.1:8787 OWNER=owner-token N=2000 C=8 node support/scim-load.js
 *
 * Phases (all against one tenant):
 *   A. create N users, C in flight (Entra ID / Okta initial cycle)
 *   B. one group, members added in PATCHes of 50, 4 in flight (same row → contention)
 *   C. deactivate 10 % of users, C in flight, while an operator hits /api/compile
 *   D. read latency for the admin UI at this size
 * Prints throughput, p50/p95/p99/max latency and every non-2xx status, then
 * checks nothing was lost (group has N members, deactivated users inactive).
 * Works against the Node server or `wrangler dev` (local D1).
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OWNER = process.env.OWNER || 'owner-token';
const N = Number(process.env.N || 2000);
const C = Number(process.env.C || 8);
const DOMAIN = process.env.DOMAIN || 'load.example';

async function raw(method, path, { token, body, contentType = 'application/json' } = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, ms: performance.now() - t0 };
}

function stats(label, results, wallMs) {
  const ms = results.map(r => r.ms).sort((a, b) => a - b);
  const q = p => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]?.toFixed(0);
  const codes = {};
  for (const r of results) codes[r.status] = (codes[r.status] || 0) + 1;
  const row = { phase: label, requests: results.length, 'req/s': (results.length / (wallMs / 1000)).toFixed(1),
    p50: q(0.5), p95: q(0.95), p99: q(0.99), max: ms[ms.length - 1]?.toFixed(0), statuses: JSON.stringify(codes) };
  console.log(JSON.stringify(row));
  return row;
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function timed(label, items, concurrency, fn) {
  const t0 = performance.now();
  const res = await pool(items, concurrency, fn);
  return { res, row: stats(label, res, performance.now() - t0) };
}

(async () => {
  const stamp = Date.now().toString(36);
  const op = await raw('POST', '/api/operators', { token: OWNER, body: { name: `Load ${stamp}`, role: 'r_provisioner' } });
  if (op.status !== 200) throw new Error(`cannot create provisioner: ${op.status} ${op.text}`);
  const prov = op.body.token;
  const scim = (m, u, b) => raw(m, `/scim/v2${u}`, { token: prov, body: b, contentType: 'application/scim+json' });
  const rows = [];
  const failures = [];
  const keep = (res) => { for (const r of res) if (r.status >= 300) failures.push(`${r.status} ${r.text.slice(0, 160)}`); };

  const A = await timed(`A create ${N} users (C=${C})`, [...Array(N).keys()], C,
    i => scim('POST', '/Users', { userName: `u${i}-${stamp}@${DOMAIN}`, displayName: `Load ${i}`, active: true }));
  rows.push(A.row); keep(A.res);
  const ids = A.res.filter(r => r.status === 201).map(r => r.body.id);

  const g = await scim('POST', '/Groups', { displayName: `SG-Load-${stamp}` });
  const batches = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  const B = await timed(`B add ${ids.length} members, 50/PATCH (C=4)`, batches, 4,
    batch => scim('PATCH', `/Groups/${g.body.id}`, { Operations: [{ op: 'Add', path: 'members', value: batch.map(value => ({ value })) }] }));
  rows.push(B.row); keep(B.res);

  const off = ids.filter((_, i) => i % 10 === 0);
  let compiling = true;
  const reads = [];
  const reader = (async () => {
    while (compiling) reads.push(await raw('GET', '/api/compile', { token: OWNER }));
  })();
  const Cc = await timed(`C deactivate ${off.length} (C=${C})`, off, C,
    id => scim('PATCH', `/Users/${id}`, { Operations: [{ op: 'Replace', value: { active: false } }] }));
  compiling = false; await reader;
  rows.push(Cc.row); keep(Cc.res);
  rows.push(stats('C concurrent GET /api/compile', reads, reads.reduce((s, r) => s + r.ms, 0))); keep(reads);

  const D = await timed('D admin reads (users, credentials, audit, compile)', ['/api/users', '/api/credentials', '/api/audit?limit=100', '/api/compile', '/api/reports/revocation'].flatMap(p => [p, p, p]), 1,
    p => raw('GET', p, { token: OWNER }));
  rows.push(D.row); keep(D.res);

  // Nothing lost?
  const group = await scim('GET', `/Groups/${g.body.id}`);
  const members = (group.body.members || []).length;
  const sampleOff = await Promise.all(off.slice(0, 20).map(id => scim('GET', `/Users/${id}`)));
  const stillActive = sampleOff.filter(r => r.body.active !== false).length;
  console.log(JSON.stringify({ created: ids.length, of: N, groupMembers: members, deactivatedStillActive: stillActive, failures: failures.length }));
  if (failures.length) console.log('first failures:\n  ' + [...new Set(failures)].slice(0, 8).join('\n  '));
  const ok = ids.length === N && members === ids.length && stillActive === 0 && failures.length === 0;
  console.log(ok ? 'RESULT: no lost or failed writes' : 'RESULT: FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
