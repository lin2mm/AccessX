const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');
const { formatMessage } = require('../alerts-core');

const OWNER = { token: 'owner-token' };
const M1 = { token: 'm1-token' };
const SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
const OPERATORS = JSON.stringify([
  { id: 'op_m1', name: 'Manager One', role: 'r_manager', tokenSha256: sha256Hex('m1-token') },
  { id: 'op_m2', name: 'Manager Two', role: 'r_manager', tokenSha256: sha256Hex('m2-token') },
]);

// These tests count deliveries; the demo fleet's genuinely low battery
// (Cleaner Cupboard, 15%) would add a battery_low alert to the first
// maintenance run. Battery alerts are tested in lock-health.api.test.js.
async function bootQuiet(env) {
  const api = await boot(env);
  await api.server.store.sql.batch([{ sql: "UPDATE tenants SET settings = json_set(COALESCE(settings, '{}'), '$.batteryCheckedAt', ?)", params: [new Date().toISOString()] }]);
  return api;
}

/** A local "Slack/Teams" that records what it receives. */
async function receiver(t, status = 200) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { got.push({ path: req.url, body: JSON.parse(b || '{}') }); res.writeHead(status); res.end('ok'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/hook/SECRET-PART`, got };
}

test('message formats: Slack text, Teams Workflows adaptive card, JSON', () => {
  const m = { event: 'removal_overdue', title: 'T', text: 'body', facts: [['Door', 'Server room (9002)']], link: 'https://x.example/#reports', tenant: { id: 't' }, at: 'now' };
  assert.match(formatMessage('slack', m).text, /^\*T\*\nbody\n• Door: Server room \(9002\)\n<https:\/\/x\.example\/#reports\|Open AccessX>$/);
  const teams = formatMessage('teams', m);
  assert.equal(teams.type, 'message');
  assert.equal(teams.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  const card = teams.attachments[0].content;
  assert.equal(card.type, 'AdaptiveCard');
  assert.deepEqual(card.body[2], { type: 'FactSet', facts: [{ title: 'Door', value: 'Server room (9002)' }] });
  assert.equal(card.actions[0].type, 'Action.OpenUrl');
  assert.deepEqual(formatMessage('json', m).facts, { Door: 'Server room (9002)' });
});

test('alerts: webhook sealed + owner-only; approval requests, overdue removals (per-tenant SLA) and first revoke failures reach the channel once', async t => {
  const hook = await receiver(t);
  const api = await bootQuiet({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', PUBLIC_URL: 'https://accessx.example', RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);

  assert.equal((await api.call('PUT', '/api/alerts', { ...M1, body: { webhookUrl: hook.url } })).status, 403, 'managers cannot redirect alerts');
  assert.equal((await api.call('PUT', '/api/alerts', { ...OWNER, body: { slaHours: 0 } })).status, 400);
  assert.equal((await api.call('PUT', '/api/alerts', { ...OWNER, body: { events: ['everything'] } })).status, 400);
  const saved = await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: hook.url, format: 'slack', slaHours: 24 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.alerts.host, new URL(hook.url).host);
  assert.ok(!JSON.stringify(saved.body).includes('SECRET-PART'), 'the URL is never returned');
  const row = await api.server.store.sql.first("SELECT settings FROM tenants WHERE id = 't_default'");
  assert.ok(!row.settings.includes('SECRET-PART'), 'nor stored in clear');

  const test1 = await api.call('POST', '/api/alerts/test', { ...OWNER, body: {} });
  assert.equal(test1.body.delivery, 'delivered');
  assert.equal(hook.got.at(-1).path, '/hook/SECRET-PART');
  assert.match(hook.got.at(-1).body.text, /AccessX test alert/);
  assert.equal(test1.body.alerts.lastDelivery.status, 'delivered');

  // Four-eyes request → the channel hears about it.
  await api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Server room', siteId: 'site_river', lockIds: [9002], sensitive: true } });
  const n0 = hook.got.length;
  assert.equal((await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9002, userId: 'u2' } })).status, 202);
  assert.equal(hook.got.length, n0 + 1);
  assert.match(hook.got.at(-1).body.text, /Approval needed[\s\S]*Manager One[\s\S]*Doors: 9002[\s\S]*https:\/\/accessx\.example\/#log/);

  // Offline lock, per-tenant SLA of 24 h: 25 h old → alert once.
  const issued = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9004, userId: 'u3', acknowledgeScheduleGap: true } });
  const credId = issued.body.credential.id;
  await api.call('POST', '/api/users/u3/suspend', OWNER);
  await api.server.store.sql.batch([{ sql: 'UPDATE credentials SET revoked_at = ? WHERE id = ?', params: [new Date(Date.now() - 25 * 36e5).toISOString(), credId] }]);
  const n1 = hook.got.length;
  const r1 = await api.call('POST', '/api/reconcile', { ...OWNER, body: {} });
  assert.equal(r1.body.summary.escalated, 1, 'overdue under the tenant\'s 24 h SLA');
  assert.equal(r1.body.plan.notices.find(n => n.type === 'removal_overdue').slaHours, 24);
  assert.equal(hook.got.length, n1 + 1);
  assert.match(hook.got.at(-1).body.text, /past the 24 h removal target[\s\S]*CleanCo|past the 24 h removal target/);
  await api.call('POST', '/api/reconcile', { ...OWNER, body: {} });
  assert.equal(hook.got.length, n1 + 1, 'not again on the next run');
  assert.equal((await api.call('GET', '/api/reports/revocation', OWNER)).body.slaHours, 24);
  assert.equal((await api.call('GET', '/api/reports/evidence', OWNER)).body.evidence.accessRemoval.slaHours, 24);

  // Disabled event → silence.
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { events: ['removal_overdue'] } });
  const n2 = hook.got.length;
  const again = await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9002, userId: 'u2' } });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal(hook.got.length, n2, 'approval_requested switched off');
  const audit = (await api.call('GET', '/api/audit?action=alerts.settings', OWNER)).body.log;
  assert.ok(audit.length >= 2 && !audit.some(e => e.detail.includes('SECRET-PART')));
});

test('a revoke that fails alerts once; a dead webhook never fails the change', async t => {
  const hook = await receiver(t, 500);
  const api = await bootQuiet({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: hook.url, format: 'teams' } });
  const issued = await api.call('POST', '/api/passcode', { ...OWNER, body: { lockId: 9002, userId: 'u2' } });
  assert.equal(issued.status, 200);
  // Make the vendor refuse deletes.
  const vendor = api.server.vendorFor ? api.server.vendorFor('t_default') : null;
  assert.ok(vendor && vendor.deletePasscode, 'test needs the demo vendor');
  const orig = vendor.deletePasscode;
  vendor.deletePasscode = async () => { throw new Error('gateway timeout'); };
  t.after(() => { vendor.deletePasscode = orig; });
  const s1 = await api.call('POST', '/api/users/u2/suspend', OWNER);
  assert.equal(s1.status, 200, 'the suspension itself succeeds although the webhook returns 500');
  const n1 = hook.got.length;
  assert.ok(n1 >= 1);
  const card = hook.got.at(-1).body.attachments[0].content;
  assert.match(card.body[0].text, /Could not revoke 1 code — it still works/);
  await api.call('POST', '/api/reconcile', { ...OWNER, body: {} });
  assert.equal(hook.got.length, n1, 'the same failing credential does not alert every run');
  const st = (await api.call('GET', '/api/alerts', OWNER)).body.alerts;
  assert.equal(st.lastDelivery.status, 'failed: HTTP 500 (will retry)');
  assert.equal(st.retrying.count, 1, 'a 500 is transient: queued for retry');
  assert.equal(st.format, 'teams');
});

/** Answers with the scripted statuses in turn (the last one repeats); records headers and bodies. */
async function scripted(t, statuses) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, body: JSON.parse(b || '{}') });
      res.writeHead(statuses[Math.min(got.length - 1, statuses.length - 1)], { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, url: `http://127.0.0.1:${srv.address().port}/hook/SECRET-PART`, got };
}
const outbox = api => api.server.store.sql.all('SELECT * FROM alert_outbox ORDER BY created_at');
const makeDue = api => api.server.store.sql.batch([{ sql: 'UPDATE alert_outbox SET next_at = ?', params: [new Date(Date.now() - 1000).toISOString()] }]);
/** Four-eyes request on a sensitive door → one approval_requested alert. */
async function requestApproval(api) {
  const dg = (await api.call('GET', '/api/doorGroups', OWNER)).body.doorGroups;
  if (!dg.some(g => g.sensitive)) await api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Server room', siteId: 'site_river', lockIds: [9002], sensitive: true } });
  const r = await api.call('POST', '/api/passcode', { ...M1, body: { lockId: 9002, userId: 'u2' } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
}

test('undelivered alerts are retried with backoff by the scheduled maintenance, same id each time', async t => {
  const hook = await scripted(t, [500, 503, 200]);
  const api = await bootQuiet({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: hook.url, format: 'json' } });
  await requestApproval(api);
  assert.equal(hook.got.length, 1);
  let q = await outbox(api);
  assert.equal(q.length, 1);
  assert.equal(q[0].channel, 'webhook');
  assert.equal(q[0].event, 'approval_requested');
  assert.ok(!JSON.stringify(q).includes('SECRET-PART'), 'the outbox never holds the URL');
  const st = (await api.call('GET', '/api/alerts', OWNER)).body.alerts;
  assert.equal(st.lastDelivery.status, 'failed: HTTP 500 (will retry)');
  assert.equal(st.retrying.count, 1);

  await api.server.api.maintenance();
  assert.equal(hook.got.length, 1, 'not due yet (5 min backoff)');

  await makeDue(api);
  const m1 = await api.server.api.maintenance();
  assert.deepEqual({ ...m1.find(r => r.tenantId === 't_default').alerts }, { retried: 1, delivered: 0, dropped: 0, pending: 1 });
  q = await outbox(api);
  assert.equal(q[0].attempts, 2);
  const wait = Date.parse(q[0].next_at) - Date.now();
  assert.ok(wait > 9 * 60e3 && wait <= 10 * 60e3, `second backoff is 10 min, got ${wait}`);

  await makeDue(api);
  await api.server.api.maintenance();
  assert.equal(hook.got.length, 3);
  assert.equal((await outbox(api)).length, 0);
  assert.equal((await api.call('GET', '/api/alerts', OWNER)).body.alerts.lastDelivery.status, 'delivered (retry 2)');
  const ids = hook.got.map(g => g.body.id);
  assert.ok(ids[0] && ids.every(id => id === ids[0]), 'one alert id across retries: receivers can de-duplicate');
  assert.equal(hook.got[2].body.type, 'accessx.alert.approval_requested');
});

test('a 4xx is not retried; the 8th failure is given up and audited; removing the channel clears its queue', async t => {
  const gone = await scripted(t, [404]);
  const dead = await scripted(t, [500]);
  const api = await bootQuiet({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);

  await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: gone.url } });
  await requestApproval(api);
  assert.equal((await outbox(api)).length, 0, '404 = misconfigured webhook: retrying will not help');
  assert.equal((await api.call('GET', '/api/alerts', OWNER)).body.alerts.lastDelivery.status, 'failed: HTTP 404');

  await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: dead.url } });
  await requestApproval(api);
  await api.server.store.sql.batch([{ sql: 'UPDATE alert_outbox SET attempts = 7' }]);
  await makeDue(api);
  const m = await api.server.api.maintenance();
  assert.equal(m.find(r => r.tenantId === 't_default').alerts.dropped, 1);
  assert.equal((await outbox(api)).length, 0);
  const log = (await api.call('GET', '/api/audit?action=alerts.dropped', OWNER)).body.log;
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /webhook approval_requested after 8 attempts: failed: HTTP 500/);
  assert.match((await api.call('GET', '/api/alerts', OWNER)).body.alerts.lastDelivery.status, /gave up/);

  await requestApproval(api);
  assert.equal((await outbox(api)).length, 1);
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: '' } });
  await makeDue(api);
  const before = dead.got.length;
  await api.server.api.maintenance();
  assert.equal((await outbox(api)).length, 0);
  assert.equal(dead.got.length, before, 'nothing is sent to a channel that was removed');
});

test('email alerts through Resend or Postmark: recipients validated, never audited; retries keep the idempotency key', async t => {
  const resend = await scripted(t, [200, 502, 200]);
  const api = await bootQuiet({
    ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', RECONCILE_INTERVAL_MIN: '0', PUBLIC_URL: 'https://accessx.example',
    EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_test_key', EMAIL_FROM: 'AccessX <alerts@accessx.example>', EMAIL_API_BASE: resend.base,
  });
  t.after(api.close);
  assert.equal((await api.call('PUT', '/api/alerts', { ...OWNER, body: { emails: ['not-an-email'] } })).status, 400);
  assert.equal((await api.call('PUT', '/api/alerts', { ...OWNER, body: { emails: ['a@x.example\r\nBcc: evil@x.example'] } })).status, 400, 'no header injection');
  assert.equal((await api.call('PUT', '/api/alerts', { ...OWNER, body: { emails: Array.from({ length: 11 }, (_, i) => `p${i}@x.example`) } })).status, 400);
  assert.equal((await api.call('PUT', '/api/alerts', { ...M1, body: { emails: ['m@x.example'] } })).status, 403);
  const saved = await api.call('PUT', '/api/alerts', { ...OWNER, body: { emails: ['Security@Riverside.example', 'security@riverside.example', 'it@riverside.example'] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.alerts.emails, ['security@riverside.example', 'it@riverside.example']);
  assert.equal(saved.body.alerts.emailProvider, 'resend');
  const audit = (await api.call('GET', '/api/audit?action=alerts.settings', OWNER)).body.log[0].detail;
  assert.match(audit, /emails=2/);
  assert.ok(!audit.includes('riverside.example'), 'recipients are personal data: counted, not logged');

  const t1 = await api.call('POST', '/api/alerts/test', { ...OWNER, body: {} });
  assert.equal(t1.body.delivery, 'delivered');
  const mail = resend.got[0];
  assert.equal(mail.path, '/emails');
  assert.equal(mail.headers.authorization, 'Bearer re_test_key');
  assert.match(mail.headers['idempotency-key'], /^accessx-[0-9a-f-]{36}$/);
  assert.deepEqual(mail.body.to, ['security@riverside.example', 'it@riverside.example']);
  assert.equal(mail.body.from, 'AccessX <alerts@accessx.example>');
  assert.equal(mail.body.subject, '[AccessX] AccessX test alert');
  assert.match(mail.body.text, /Open AccessX: https:\/\/accessx\.example\//);
  assert.equal(mail.body.html, undefined, 'plain text only');

  // 502 → queued; the retry reuses the idempotency key (Resend drops a duplicate).
  await requestApproval(api);
  const q = await outbox(api);
  assert.equal(q.length, 1);
  assert.equal(q[0].channel, 'email');
  assert.ok(!JSON.stringify(q).includes('riverside.example'), 'the outbox never holds recipients');
  await makeDue(api);
  await api.server.api.maintenance();
  assert.equal(resend.got.length, 3);
  assert.equal(resend.got[2].headers['idempotency-key'], resend.got[1].headers['idempotency-key']);
  assert.match(resend.got[2].body.subject, /Approval needed/);

  // Webhook and email together: both channels, one status each.
  const hook = await scripted(t, [200]);
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: hook.url } });
  assert.equal((await api.call('POST', '/api/alerts/test', { ...OWNER, body: {} })).body.delivery, 'webhook: delivered; email: delivered');
});

test('Postmark request shape; email recipients need a configured provider; bad provider config fails at start', async t => {
  const pm = await scripted(t, [200]);
  const api = await bootQuiet({
    ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, RECONCILE_INTERVAL_MIN: '0',
    EMAIL_PROVIDER: 'postmark', EMAIL_API_KEY: 'pm-server-token', EMAIL_FROM: 'alerts@accessx.example', EMAIL_API_BASE: pm.base,
  });
  t.after(api.close);
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { emails: ['a@x.example', 'b@x.example'] } });
  assert.equal((await api.call('POST', '/api/alerts/test', { ...OWNER, body: {} })).body.delivery, 'delivered');
  const m = pm.got[0];
  assert.equal(m.path, '/email');
  assert.equal(m.headers['x-postmark-server-token'], 'pm-server-token');
  assert.equal(m.body.To, 'a@x.example,b@x.example');
  assert.equal(m.body.MessageStream, 'outbound');
  assert.match(m.body.TextBody, /AccessX test alert/);

  const plain = await bootQuiet({ ADMIN_TOKEN: 'owner-token', SECRETS_KEY, RECONCILE_INTERVAL_MIN: '0' });
  t.after(plain.close);
  const r = await plain.call('PUT', '/api/alerts', { ...OWNER, body: { emails: ['a@x.example'] } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /EMAIL_PROVIDER/);

  const { createAlerts } = require('../alerts-core');
  assert.throws(() => createAlerts({ store: {}, email: { provider: 'smtp', apiKey: 'k', from: 'a@b.c' } }), /EMAIL_PROVIDER must be one of resend, postmark/);
  assert.throws(() => createAlerts({ store: {}, email: { provider: 'resend', apiKey: '', from: 'a@b.c' } }), /EMAIL_API_KEY/);
});

test('TTLock refusing the account alerts the owners once (vendor_needs_reconnect)', async t => {
  const { demoFixture } = require('../support/fake-ttlock');
  const cloud = demoFixture();
  const base = await cloud.listen(0);
  const hook = await scripted(t, [200]);
  const api = await bootQuiet({
    ADMIN_TOKEN: 'owner-token', SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', RECONCILE_INTERVAL_MIN: '0',
    TTLOCK_API_BASE: base, TTLOCK_CLIENT_ID: 'platform-app', TTLOCK_CLIENT_SECRET: 'platform-secret',
  });
  t.after(async () => { await api.close(); await cloud.close(); });
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...OWNER, body: { region: 'eu', username: 'riverside-admin', password: 'river-pass-1' } })).status, 200);
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: hook.url, format: 'slack' } });
  cloud.revokeAccount('riverside-admin');
  for (let i = 0; i < 3; i++) assert.equal((await api.call('POST', '/api/doors/9001/unlock', { ...OWNER, body: { reason: 'delivery' } })).status, 503);
  const alertsSent = hook.got.filter(g => /TTLock account must be reconnected/.test(g.body.text));
  assert.equal(alertsSent.length, 1, 'one alert per incident, not per failed request');
  assert.match(alertsSent[0].body.text, /uid 71001/);
  assert.ok(!alertsSent[0].body.text.includes('riverside-admin'), 'the TTLock username is not sent');
});

// ---- Daily summary (digest) -----------------------------------------------------------
test('daily summary: non-urgent events wait and go out as one message at the local hour; security events cannot wait', async t => {
  const hook = await scripted(t, [200]);
  const api = await bootQuiet({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: hook.url, format: 'json' } });
  for (const bad of [{ events: ['break_glass'], hour: 8, timeZone: 'Europe/London' }, { events: ['approval_requested'], hour: 24, timeZone: 'Europe/London' }, { events: ['approval_requested'], hour: 8, timeZone: 'Mars/Olympus' }]) {
    const r = await api.call('PUT', '/api/alerts', { ...OWNER, body: { digest: bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await api.call('PUT', '/api/alerts', { ...M1, body: { digest: null } })).status, 403);
  const saved = await api.call('PUT', '/api/alerts', { ...OWNER, body: { digest: { events: ['approval_requested', 'removal_overdue'], hour: 8, timeZone: 'Europe/London' } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const next = Date.parse(saved.body.alerts.digestPending.nextAt);
  assert.ok(next > Date.now() && next <= Date.now() + 864e5, 'next summary within a day');
  assert.match(new Date(next).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), /^08:00$/);
  const audit = (await api.call('GET', '/api/audit?action=alerts.settings', OWNER)).body.log[0];
  assert.match(audit.detail, /digest=approval_requested,removal_overdue@08:00 Europe\/London/);

  await requestApproval(api);
  await requestApproval(api);
  assert.equal(hook.got.length, 0, 'batched, not sent');
  let q = await outbox(api);
  assert.deepEqual(q.map(r => r.channel), ['digest', 'digest']);
  assert.equal((await api.call('GET', '/api/alerts', OWNER)).body.alerts.retrying.count, 0, 'waiting ≠ retrying');
  assert.equal((await api.call('GET', '/api/alerts', OWNER)).body.alerts.digestPending.count, 2);
  const m0 = await api.server.api.maintenance();
  assert.equal(m0.find(r => r.tenantId === 't_default').digest, undefined, 'not 08:00 yet');
  assert.equal(hook.got.length, 0);
  const tt = await api.call('POST', '/api/alerts/test', { ...OWNER, body: {} });
  assert.equal(tt.body.delivery, 'delivered', 'a test alert is never batched');

  await makeDue(api);
  const m1 = await api.server.api.maintenance();
  assert.equal(m1.find(r => r.tenantId === 't_default').digest.items, 2);
  assert.equal(hook.got.length, 2);
  const sum = hook.got[1].body;
  assert.equal(sum.type, 'accessx.alert.digest');
  assert.equal(sum.title, 'Daily summary: 2 alerts');
  assert.match(sum.text, /^Approvals requested \(2\)\n• \d{4}-\d\d-\d\d \d\d:\d\d .*Manager One/);
  assert.deepEqual(sum.facts, { 'Approvals requested': '2' });
  assert.equal((await outbox(api)).length, 0);
  await api.server.api.maintenance();
  assert.equal(hook.got.length, 2, 'sent once');

  // Switched off: alerts are instant again.
  await api.call('PUT', '/api/alerts', { ...OWNER, body: { digest: null } });
  await requestApproval(api);
  assert.equal(hook.got.length, 3);
  assert.equal(hook.got[2].body.type, 'accessx.alert.approval_requested');
});

test('nextDigestAt: local hour across DST changes', () => {
  const { nextDigestAt } = require('../alerts-core');
  // London clocks go back 25 Oct 2026 02:00 BST → 01:00 GMT; Sydney forward 4 Oct 2026 02:00 → 03:00.
  assert.equal(new Date(nextDigestAt(8, 'Europe/London', Date.parse('2026-10-24T08:30:00Z'))).toISOString(), '2026-10-25T08:00:00.000Z', '08:00 GMT');
  assert.equal(new Date(nextDigestAt(8, 'Europe/London', Date.parse('2026-10-24T06:00:00Z'))).toISOString(), '2026-10-24T07:00:00.000Z', '08:00 BST');
  assert.equal(new Date(nextDigestAt(2, 'Australia/Sydney', Date.parse('2026-10-03T12:00:00Z'))).toISOString(), '2026-10-03T16:00:00.000Z', '02:00 does not exist on 4 Oct: 03:00 AEDT');
  assert.equal(new Date(nextDigestAt(0, 'UTC', Date.parse('2026-01-01T00:00:00Z'))).toISOString(), '2026-01-02T00:00:00.000Z', 'strictly after now');
});
