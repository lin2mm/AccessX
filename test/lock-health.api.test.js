const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');

const OWNER = { token: 'owner-token' };
const GYM = { token: 'gym-token' };
const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
const OPERATORS = JSON.stringify([{ id: 'op_gym', name: 'Gym Manager', role: 'r_manager', siteIds: ['site_gym'], tokenSha256: sha256Hex('gym-token') }]);
const NOTIFY = 'notify-secret-health';
const DAY = 864e5;
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

async function receiver(t) {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { got.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('ok'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/hook/x`, got };
}
async function setup(t, env = {}) {
  const hook = await receiver(t);
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', RECONCILE_INTERVAL_MIN: '0', ...env });
  t.after(api.close);
  assert.equal((await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: hook.url, format: 'json' } })).status, 200);
  return { api, hook, sql: api.server.store.sql, maintain: () => api.server.api.maintainOne('t_default') };
}
const marker = (sql, key, value) => sql.batch([{ sql: `UPDATE tenants SET settings = json_set(COALESCE(settings, '{}'), '$.${key}', ?) WHERE id = 't_default'`, params: [value] }]);
const notify = (api, records) => fetch(`${api.base}/api/ttlock/notify/${NOTIFY}`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ lockId: String(records[0].lockId), notifyType: '1', records: JSON.stringify(records) }),
});

test('battery: low locks alert once; a falling trend warns ~3 weeks ahead; one grouped message; readings from callbacks', async t => {
  const { api, hook, sql, maintain } = await setup(t, { TTLOCK_NOTIFY_SECRET: NOTIFY });
  // 9003 Warehouse (42% today in the demo fleet) has fallen 2 %/day: ~16 days to 10 %.
  const now = Date.now();
  await sql.batch(Array.from({ length: 10 }, (_, i) => ({ sql: 'INSERT INTO lock_battery (tenant_id, lock_id, day, level) VALUES (?, ?, ?, ?)', params: ['t_default', 9003, dayOf(now - (10 - i) * DAY), 62 - 2 * i] })));
  const out = await maintain();
  assert.equal(out.batteryAlerts, 2, JSON.stringify(out));
  const msgs = hook.got.filter(m => m.type === 'accessx.alert.battery_low');
  assert.equal(msgs.length, 1, 'one grouped message');
  assert.equal(msgs[0].title, '2 locks need new batteries');
  assert.match(msgs[0].text, /Plan a battery visit this week/);
  assert.match(msgs[0].text, /Cleaner Cupboard — 15% · no gateway: level as of the last app sync/);
  assert.match(msgs[0].text, /Warehouse Side Door — 42%, about 1[56] days left \(2%\/day\)/);
  assert.ok(msgs[0].tenant, 'tenant tagged');

  // Within 6 h: not even looked at. After: same bands, no repeat.
  assert.equal((await maintain()).batteryAlerts, undefined);
  await marker(sql, 'batteryCheckedAt', new Date(now - 7 * 36e5).toISOString());
  assert.equal((await maintain()).batteryAlerts, undefined);
  assert.equal(hook.got.filter(m => m.type === 'accessx.alert.battery_low').length, 1);

  // Health view: forecasts, scoped per operator.
  const h = await api.call('GET', '/api/doors/health', OWNER);
  const w = h.body.locks.find(l => l.lockId === 9003);
  assert.equal(w.band, 'forecast');
  assert.equal(w.slopePerDay, -2);
  assert.equal(h.body.locks.find(l => l.lockId === 9004).band, 'low');
  assert.deepEqual((await api.call('GET', '/api/doors/health', GYM)).body.locks.map(l => l.lockId).sort(), [9101, 9102]);

  // Callback records carry the level at that moment.
  await notify(api, [{ lockId: 9101, recordType: 1, success: 1, lockDate: now, serverDate: now, electricQuantity: 64 }]);
  const r = await sql.first('SELECT level FROM lock_battery WHERE tenant_id = ? AND lock_id = 9101 AND day = ?', ['t_default', dayOf(now)]);
  assert.equal(r.level, 64);
  // The lock list (66% for 9101, possibly stale) does not raise the day's reading.
  await marker(sql, 'batteryCheckedAt', new Date(now - 7 * 36e5).toISOString());
  await maintain();
  assert.equal((await sql.first('SELECT level FROM lock_battery WHERE tenant_id = ? AND lock_id = 9101 AND day = ?', ['t_default', dayOf(now)])).level, 64);
});

test('callback silent: records TTLock never sent → one alert + audit + back-fill; a new callback clears it', async t => {
  const { api, hook, sql, maintain } = await setup(t, { TTLOCK_NOTIFY_SECRET: NOTIFY });
  // Never worked yet: no alert (the settings page says so).
  await marker(sql, 'batteryCheckedAt', new Date().toISOString());
  assert.equal((await maintain()).callbackSilent, undefined);
  await notify(api, [{ lockId: 9001, recordType: 1, success: 1, lockDate: Date.now(), serverDate: Date.now() }]);
  // ...then it went quiet five days ago (≥ 3 weekdays), while the demo locks kept logging.
  const lastAt = new Date(Date.now() - 5 * DAY).toISOString();
  await marker(sql, 'ttlockCallbackAt', lastAt);
  const out = await maintain();
  assert.ok(out.callbackSilent > 0, JSON.stringify(out));
  const m = hook.got.filter(x => x.type === 'accessx.alert.callback_silent');
  assert.equal(m.length, 1);
  assert.match(m[0].text, /one URL per app/);
  assert.equal(m[0].facts['Last callback'], lastAt);
  assert.match((await api.call('GET', '/api/audit?action=ttlock.callback_silent', OWNER)).body.log[0].detail, /record\(s\) on \d door\(s\) were not delivered/);
  assert.equal((await api.call('GET', '/api/doors/health', OWNER)).body.callback.silent, true);

  // Same silence: not raised again, even after the hourly re-check window.
  await marker(sql, 'callbackCheckedAt', new Date(Date.now() - 2 * 36e5).toISOString());
  assert.equal((await maintain()).callbackSilent, undefined);
  assert.equal(hook.got.filter(x => x.type === 'accessx.alert.callback_silent').length, 1);

  await notify(api, [{ lockId: 9001, recordType: 1, success: 1, lockDate: Date.now(), serverDate: Date.now() }]);
  assert.equal((await api.call('GET', '/api/doors/health', OWNER)).body.callback.silent, false);
});

test('callback silence is not checked without TTLOCK_NOTIFY_SECRET', async t => {
  const { sql, maintain } = await setup(t);
  await marker(sql, 'ttlockCallbackAt', new Date(Date.now() - 5 * DAY).toISOString());
  await marker(sql, 'batteryCheckedAt', new Date().toISOString());
  assert.equal(await maintain().then(o => o.callbackSilent), undefined);
});
