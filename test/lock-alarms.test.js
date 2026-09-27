const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot } = require('../support/boot');
const { alarmCandidates } = require('../lock-events-core');

const OWNER = { token: 'owner-token' };
const PLATFORM = { token: 'platform-token' };
const NOTIFY = 'alarm-notify-secret';
const SECRETS_KEY = Buffer.alloc(32, 6).toString('base64');

async function receiver(t) {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { got.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('ok'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/hook/x`, got };
}
const notify = (api, records) => fetch(`${api.base}/api/ttlock/notify/${NOTIFY}`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ lockId: String(records[0].lockId), notifyType: '1', records: JSON.stringify(records) }),
}).then(async r => ({ status: r.status, text: await r.text() }));
const alarm = (lockId, recordType, at) => ({ lockId, recordType, recordTypeFromLock: recordType, success: 1, lockDate: at, serverDate: at, username: '', keyboardPwd: '' });

test('alarmCandidates: only alarm types, sane ids and times, deduplicated', () => {
  const now = Date.parse('2026-09-27T10:00:00Z');
  const got = alarmCandidates([
    alarm(9001, 44, now - 1000), alarm(9001, 44, now - 1000), alarm(9001, 48, now), alarm(9002, 29, now), alarm(9003, 64, now),
    { lockId: 9001, recordType: 4, success: 0, lockDate: now }, alarm(-1, 44, now), alarm(9001, 44, now + 3 * 864e5), alarm('x', 44, now), null, 'junk',
  ], { now });
  assert.deepEqual(got.map(a => `${a.lockId}:${a.kind}`), ['9001:tamper', '9001:keypad_locked', '9002:forced', '9003:door_left_open']);
});

test('lock alarms from the TTLock callback: announced once per 30 min, audited, instant even with a daily summary; door-left-open is opt-in', async t => {
  const hook = await receiver(t);
  const api = await boot({ ADMIN_TOKEN: 'owner-token', PLATFORM_TOKEN: 'platform-token', SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', TTLOCK_NOTIFY_SECRET: NOTIFY, RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  const put = await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: hook.url, format: 'json', digest: { events: ['approval_requested'], hour: 8, timeZone: 'Europe/London' } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.ok(put.body.alerts.events.includes('lock_alarm'), 'on by default');
  assert.ok(!put.body.alerts.events.includes('door_left_open'), 'opt-in');
  assert.equal((await api.call('PUT', '/api/alerts', { ...OWNER, body: { digest: { events: ['lock_alarm'], hour: 8, timeZone: 'UTC' } } })).status, 400, 'a security alarm cannot wait');

  const t0 = Date.now() - 5 * 60e3;
  assert.equal((await notify(api, [alarm(9002, 44, t0)])).text, 'success');
  assert.equal(hook.got.length, 1);
  assert.equal(hook.got[0].type, 'accessx.alert.lock_alarm');
  assert.equal(hook.got[0].title, 'Server Room: tamper alarm');
  assert.equal(hook.got[0].facts.Alarm, 'tamper');
  // Same alarm again (TTLock may resend), and another within 30 min: stored, not re-announced.
  await notify(api, [alarm(9002, 44, t0), alarm(9002, 44, t0 + 60e3)]);
  assert.equal(hook.got.length, 1);
  const rows = await api.server.store.sql.all("SELECT * FROM lock_alarms WHERE tenant_id = 't_default' ORDER BY record_at");
  assert.deepEqual(rows.map(r => [r.lock_id, r.kind, r.alerted, r.source]), [[9002, 'tamper', 1, 'callback'], [9002, 'tamper', 0, 'callback']]);
  // A different kind is its own alarm.
  await notify(api, [alarm(9002, 48, t0 + 120e3)]);
  assert.equal(hook.got.length, 2);
  assert.match(hook.got[1].text, /several wrong codes/);
  const log = (await api.call('GET', '/api/audit?action=lock.alarm', OWNER)).body.log;
  assert.equal(log.length, 2);
  assert.match(log[1].detail, /^lock 9002 tamper at .* via callback$/);
  // A late upload (lock without gateway synced by a phone) says so.
  await notify(api, [alarm(9004, 44, Date.now() - 5 * 3600e3)]);
  assert.match(hook.got.at(-1).text, /Reported late/);
  // Door left open: opt-in.
  const n = hook.got.length;
  await notify(api, [alarm(9003, 64, t0)]);
  assert.equal(hook.got.length, n, 'not enabled');
  const cfg = (await api.call('GET', '/api/alerts', OWNER)).body.alerts;
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { events: [...cfg.events, 'door_left_open'] } });
  await notify(api, [alarm(9003, 64, t0 + 45 * 60e3)]);
  assert.equal(hook.got.at(-1).type, 'accessx.alert.door_left_open');
  // Pilot diagnostics: last callback time per tenant.
  assert.ok((await api.call('GET', '/api/visits/settings', OWNER)).body.arrivals.lastCallbackAt);
});

test("another tenant naming the same lock in a door group never hears about it (the lock must be in its own TTLock fleet)", async t => {
  const hook = await receiver(t);
  const api = await boot({ ADMIN_TOKEN: 'owner-token', PLATFORM_TOKEN: 'platform-token', SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', TTLOCK_NOTIFY_SECRET: NOTIFY, RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  const b = (await api.call('POST', '/api/tenants', { ...PLATFORM, body: { name: 'Snoop Ltd' } })).body;
  const B = { token: b.owner.token };
  assert.equal((await api.call('PUT', '/api/alerts', { ...B, body: { webhookUrl: hook.url, format: 'json' } })).status, 200);
  await api.server.store.sql.batch([{ sql: "INSERT INTO door_groups (tenant_id, id, site_id, name, lock_ids) VALUES (?, 'dg_snoop', 'site_x', 'Not mine', '[9002]')", params: [b.tenant.id] }]);
  await notify(api, [alarm(9002, 44, Date.now() - 60e3)]);
  assert.equal(hook.got.length, 0, 'tenant B was not alerted');
  assert.equal((await api.server.store.sql.first('SELECT COUNT(*) AS n FROM lock_alarms WHERE tenant_id = ?', [b.tenant.id])).n, 0);
  assert.equal((await api.server.store.sql.first("SELECT COUNT(*) AS n FROM lock_alarms WHERE tenant_id = 't_default'")).n, 1, 'the owner was');
});

test('owners who saved their event list before lock_alarm existed still get it; unticking it is respected', async t => {
  const hook = await receiver(t);
  const api = await boot({ ADMIN_TOKEN: 'owner-token', SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', TTLOCK_NOTIFY_SECRET: NOTIFY, RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: hook.url, format: 'json' } });
  // Simulate a list saved by the previous version (no eventsSeen).
  await api.server.store.sql.batch([{ sql: "UPDATE tenants SET settings = json_set(settings, '$.alerts.events', json(?)) WHERE id = 't_default'", params: [JSON.stringify(['break_glass'])] }]);
  assert.deepEqual((await api.call('GET', '/api/alerts', OWNER)).body.alerts.events, ['break_glass', 'lock_alarm']);
  await notify(api, [alarm(9001, 29, Date.now() - 60e3)]);
  assert.equal(hook.got.length, 1);
  assert.match(hook.got[0].title, /opened without a credential/);
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { events: ['break_glass'] } });
  assert.deepEqual((await api.call('GET', '/api/alerts', OWNER)).body.alerts.events, ['break_glass']);
  await notify(api, [alarm(9001, 44, Date.now() - 30e3)]); // a different kind: not throttled
  assert.equal(hook.got.length, 1, 'unticked: silent');
});
