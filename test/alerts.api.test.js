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
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', PUBLIC_URL: 'https://accessx.example', RECONCILE_INTERVAL_MIN: '0' });
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
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, ALLOW_HTTP_WEBHOOKS: '1', RECONCILE_INTERVAL_MIN: '0' });
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
  assert.equal(st.lastDelivery.status, 'failed: HTTP 500');
  assert.equal(st.format, 'teams');
});
