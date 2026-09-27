const test = require('node:test');
const assert = require('node:assert/strict');
const { createTenantQueue, QueueFullError } = require('../tenant-queue');
const { boot } = require('../support/boot');

const tick = ms => new Promise(r => setTimeout(r, ms));

test('tenant queue: one write at a time per tenant, FIFO, tenants in parallel, bounded, survives errors', async () => {
  const q = createTenantQueue({ maxDepth: 3 });
  const log = [];
  let inA = 0; let maxInA = 0;
  const job = (key, id, ms, fail) => q.run(key, async () => {
    if (key === 'A') { inA++; maxInA = Math.max(maxInA, inA); }
    log.push(`${id}+`); await tick(ms); log.push(`${id}-`);
    if (key === 'A') inA--;
    if (fail) throw new Error(`boom ${id}`);
    return id;
  });
  const a1 = job('A', 'a1', 20); const a2 = job('A', 'a2', 5, true); const a3 = job('A', 'a3', 5);
  await assert.rejects(job('A', 'a4', 1), QueueFullError, 'a 4th queued write for A is refused');
  const b1 = job('B', 'b1', 5);
  assert.equal(await a1, 'a1');
  await assert.rejects(a2, /boom a2/);
  assert.equal(await a3, 'a3', 'a failed write does not break the queue');
  assert.equal(await b1, 'b1');
  assert.equal(maxInA, 1);
  assert.deepEqual(log.filter(x => x[0] === 'a'), ['a1+', 'a1-', 'a2+', 'a2-', 'a3+', 'a3-']);
  assert.ok(log.indexOf('b1-') < log.indexOf('a1-'), 'tenant B does not wait for tenant A');
  assert.equal(await q.run(null, async () => 'unqueued'), 'unqueued');
  assert.deepEqual(q.stats().queued, {});
});

test('SCIM burst on one tenant: no optimistic-concurrency conflicts, nothing lost; reads never queue', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const prov = (await api.call('POST', '/api/operators', { token: 'owner-token', body: { name: 'Entra', role: 'r_provisioner' } })).body.token;
  // Work for the scheduled reconciler: codes of a person suspended behind its back.
  for (let i = 0; i < 3; i++) assert.equal((await api.call('POST', '/api/passcode', { token: 'owner-token', body: { lockId: 9002, userId: 'u2' } })).status, 200);
  await api.server.store.sql.batch([{ sql: "UPDATE users SET suspended = 1 WHERE tenant_id = 't_default' AND id = 'u2'", params: [] }]);
  const sql = api.server.store.sql;
  const batch = sql.batch.bind(sql);
  let conflicts = 0;
  sql.batch = async (...args) => {
    await tick(2); // widen the window like a network round-trip to D1
    try { return await batch(...args); } catch (e) { if (e.name === 'ConflictError') conflicts++; throw e; } // boot() loads its own copy of store/sql: no instanceof
  };
  const scim = (m, u, b) => api.call(m, `/scim/v2${u}`, { token: prov, body: b, contentType: 'application/scim+json' });
  // The scheduled reconciler + maintenance run in the middle of the burst.
  const [res, cron, maint] = await Promise.all([
    Promise.all([...Array(40).keys()].map(i => scim('POST', '/Users', { userName: `b${i}@burst.example`, active: true }))),
    (async () => { await tick(5); return api.server.api.reconcileAll(); })(),
    (async () => { await tick(10); return api.server.api.maintenance(); })(),
  ]);
  assert.ok(cron.every(r => !r.error), JSON.stringify(cron));
  assert.equal(cron.find(r => r.tenantId === 't_default').revoked, 3, 'the cron really wrote during the burst');
  assert.ok(maint.every(r => !r.error), JSON.stringify(maint));
  assert.deepEqual([...new Set(res.map(r => r.status))], [201]);
  const g = (await scim('POST', '/Groups', { displayName: 'SG-Burst' })).body;
  const patched = await Promise.all(res.map(r => scim('PATCH', `/Groups/${g.id}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: r.body.id }] }] })));
  assert.deepEqual([...new Set(patched.map(r => r.status))], [200]);
  assert.equal((await scim('GET', `/Groups/${g.id}`)).body.members.length, 40);
  assert.equal(conflicts, 0, 'writes of one tenant are serialized, so the audit head never conflicts');
  assert.ok(api.server.writeQueue.stats().maxDepthSeen > 1, 'the burst really was concurrent');
  assert.equal((await api.call('GET', '/api/users', { token: 'owner-token' })).status, 200);
});
