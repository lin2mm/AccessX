// Snapshot cost at scale (Node / SQLite). Seeds one tenant with N people and
// N credentials, then times: a raw snapshot read, a read-only API call, and an
// API write (which re-reads the tenant inside transact()).
//
//   N=10000 node support/snapshot-bench.js
//
// Not a test (lives in support/ so `node --test` skips it).
const { boot } = require('./boot');

const N = Number(process.env.N || 10000);
const ROUNDS = Number(process.env.ROUNDS || 20);

const ms = t0 => Number(process.hrtime.bigint() - t0) / 1e6;
const median = xs => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

(async () => {
  const api = await boot({ ADMIN_TOKEN: 'o', RECONCILE_INTERVAL_MIN: '0', ACCESSX_SNAPSHOT_GUARD: process.env.ACCESSX_SNAPSHOT_GUARD || '0' }); // production config unless asked
  const { store } = api.server;
  const sql = store.sql;
  const t = store.tenant('t_default');

  const now = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 864e5).toISOString();
  const stmts = [];
  for (let i = 0; i < N; i++) {
    stmts.push({ sql: 'INSERT INTO users (tenant_id, id, name, email, group_ids, suspended) VALUES (?, ?, ?, ?, ?, 0)',
      params: ['t_default', `bench_u${i}`, `Person ${i}`, `p${i}@bench.example`, JSON.stringify(['ug_staff'])] });
    stmts.push({ sql: "INSERT INTO credentials (tenant_id, id, type, user_id, lock_id, start_at, end_at, enforcement, rules, status, code_hint, issued_by, issued_at) VALUES (?, ?, 'passcode', ?, 9001, ?, ?, 'lock', '[]', 'expired', '••••00', 'bench', ?)",
      params: ['t_default', `bench_c${i}`, `bench_u${i}`, now, later, now] });
  }
  for (let i = 0; i < stmts.length; i += 2000) await sql.batch(stmts.slice(i, i + 2000));

  const snapTimes = [];
  for (let r = 0; r < ROUNDS; r++) { const t0 = process.hrtime.bigint(); await t.snapshot(); snapTimes.push(ms(t0)); }

  const readTimes = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = process.hrtime.bigint();
    const res = await api.call('POST', '/api/evaluate', { token: 'o', body: { userId: 'u1', lockId: 9001 } });
    readTimes.push(ms(t0));
    if (res.status !== 200) throw new Error(`evaluate ${res.status}`);
  }

  const writeTimes = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = process.hrtime.bigint();
    const res = await api.call('POST', '/api/users', { token: 'o', body: { name: `Bench write ${r}`, groupIds: ['ug_member'] } });
    writeTimes.push(ms(t0));
    if (res.status !== 200) throw new Error(`write ${res.status} ${JSON.stringify(res.body)}`);
  }

  const snap = await t.snapshot();
  console.log(JSON.stringify({
    people: snap.users.length, credentials: snap.credentials.length,
    cache: typeof store.cacheStats === 'function' ? store.cacheStats() : 'none',
    snapshotMs: +median(snapTimes).toFixed(1),
    evaluateMs: +median(readTimes).toFixed(1),
    writeMs: +median(writeTimes).toFixed(1),
  }));
  await api.close();
})().catch(e => { console.error(e); process.exit(1); });
