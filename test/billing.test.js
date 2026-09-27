const test = require('node:test');
const assert = require('node:assert/strict');
const billing = require('../billing-core');
const { boot } = require('../support/boot');
const { demoFixture } = require('../support/fake-ttlock');
const { createFakeStripe } = require('../support/fake-stripe');
const { sha256Hex } = require('../audit-core');

const WHSEC = 'whsec_test_secret';
const OWNER = { token: 'owner-token' };
const MGR = { token: 'mgr-token' };

test('formEncode, webhook signatures, standing, additions', async () => {
  assert.equal(billing.formEncode({ mode: 'subscription', line_items: [{ price: 'price_a' }, { price: 'price_b' }], metadata: { tenant_id: 't1' }, x: undefined }).toString(),
    'mode=subscription&line_items%5B0%5D%5Bprice%5D=price_a&line_items%5B1%5D%5Bprice%5D=price_b&metadata%5Btenant_id%5D=t1');
  const body = JSON.stringify({ id: 'evt_1', type: 'x' });
  const sig = await billing.signWebhook(body, WHSEC);
  assert.equal((await billing.verifyWebhook(body, sig, WHSEC)).id, 'evt_1');
  assert.equal((await billing.verifyWebhook(body, `${sig},v1=${'0'.repeat(64)}`, WHSEC)).id, 'evt_1', 'any v1 may match (secret rotation)');
  await assert.rejects(billing.verifyWebhook(body, sig, 'whsec_other'), /mismatch/);
  await assert.rejects(billing.verifyWebhook(body + ' ', sig, WHSEC), /mismatch/, 'the exact bytes are signed');
  await assert.rejects(billing.verifyWebhook(body, await billing.signWebhook(body, WHSEC, Math.floor(Date.now() / 1000) - 600), WHSEC), /tolerance/, 'replayed old delivery');
  await assert.rejects(billing.verifyWebhook(body, 'garbage', WHSEC), /header/);

  const now = Date.UTC(2026, 9, 20);
  const ago = d => new Date(now - d * 864e5).toISOString();
  assert.deepEqual(billing.standing(null, now), { status: 'none', restricted: false });
  assert.equal(billing.standing({ status: 'active' }, now).restricted, false);
  assert.deepEqual(billing.standing({ status: 'past_due', pastDueSince: ago(3) }, now), { status: 'past_due', pastDueDays: 3, restricted: false, restrictsInDays: 12 });
  assert.equal(billing.standing({ status: 'unpaid', pastDueSince: ago(15) }, now).restricted, true);
  assert.equal(billing.standing({ status: 'canceled' }, now).restricted, true);
  assert.deepEqual(billing.nextAccountState({ status: 'past_due', pastDueSince: ago(3) }, 'unpaid', ago(0)), { status: 'unpaid', pastDueSince: ago(3) }, 'grace period does not restart');
  assert.deepEqual(billing.nextAccountState({ status: 'past_due', pastDueSince: ago(3) }, 'active', ago(0)), { status: 'active', pastDueSince: null });
  assert.equal(billing.isAddition('POST', '/api/users'), true);
  assert.equal(billing.isAddition('DELETE', '/api/users/u1'), false, 'removing is never blocked');
  assert.equal(billing.isAddition('POST', '/scim/v2/Users'), true);
  assert.equal(billing.isAddition('PATCH', '/scim/v2/Users/x'), false, 'SCIM deactivation keeps working');
  assert.deepEqual(billing.billingConfigFromEnv({ BILLING_ENABLED: '1', STRIPE_SECRET_KEY: 'nope' }).problems, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_DOOR_DAYS']);
  assert.equal(billing.billingConfigFromEnv({}).active, false, 'off by default');
});

async function setup(t, env = {}) {
  const stripe = createFakeStripe();
  const stripeBase = await stripe.listen();
  const cloud = demoFixture();
  const ttBase = await cloud.listen(0);
  const OPERATORS = JSON.stringify([{ id: 'op_mgr', name: 'Manager', role: 'r_manager', tokenSha256: sha256Hex('mgr-token') }]);
  const api = await boot({
    ADMIN_TOKEN: 'owner-token', PLATFORM_TOKEN: 'platform-token', OPERATORS, SECRETS_KEY: Buffer.alloc(32, 5).toString('base64'), RECONCILE_INTERVAL_MIN: '0', PUBLIC_URL: 'https://doors.example',
    TTLOCK_API_BASE: ttBase, TTLOCK_CLIENT_ID: 'platform-app', TTLOCK_CLIENT_SECRET: 'platform-secret',
    BILLING_ENABLED: '1', STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_PRICE_DOOR_DAYS: 'price_doors', STRIPE_PRICE_SMS: 'price_sms', STRIPE_API_BASE: stripeBase, ...env,
  });
  t.after(async () => { await api.close(); await stripe.close(); await cloud.close(); });
  const tenantId = (await api.call('GET', '/api/me', OWNER)).body.tenant.id;
  const hook = async (event, { secret = WHSEC } = {}) => {
    const raw = JSON.stringify({ object: 'event', created: Math.floor(Date.now() / 1000), ...event });
    const r = await fetch(`${api.base}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': await billing.signWebhook(raw, secret) }, body: raw });
    return { status: r.status, body: await r.json() };
  };
  return { api, stripe, tenantId, hook };
}

test('subscribe: Checkout → webhook links the customer → non-payment pauses additions, never removals', async t => {
  const { api, stripe, tenantId, hook } = await setup(t);
  let b = (await api.call('GET', '/api/billing', OWNER)).body.billing;
  assert.equal(b.enabled, true); assert.equal(b.subscribed, false); assert.equal(b.testMode, true);
  assert.equal((await api.call('GET', '/api/billing', MGR)).status, 403, 'owner only');
  assert.equal((await api.call('POST', '/api/billing/checkout', { ...MGR, body: {} })).status, 403);

  const co = await api.call('POST', '/api/billing/checkout', { ...OWNER, body: {} });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  assert.equal(co.body.url, 'https://checkout.stripe.test/c/cs_test_1');
  const sent = stripe.callsTo('/v1/checkout/sessions')[0];
  assert.equal(sent.headers['stripe-version'], billing.API_VERSION);
  assert.match(sent.headers['idempotency-key'], new RegExp(`^checkout:${tenantId}:`));
  assert.equal(sent.params.mode, 'subscription');
  assert.equal(sent.params['line_items[0][price]'], 'price_doors');
  assert.equal(sent.params['line_items[1][price]'], 'price_sms');
  assert.equal(sent.params.client_reference_id, tenantId);
  assert.equal(sent.params['subscription_data[metadata][tenant_id]'], tenantId);
  assert.equal(sent.params.success_url, 'https://doors.example/#billing-done');
  assert.equal((await api.call('POST', '/api/billing/portal', { ...OWNER, body: {} })).status, 409, 'no portal before a subscription');

  assert.equal((await hook({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } }, { secret: 'whsec_forged' })).status, 400, 'forged webhook refused');
  const done = await hook({ id: 'evt_co', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: tenantId, customer: 'cus_1', subscription: 'sub_1', payment_status: 'paid' } } });
  assert.deepEqual(done, { status: 200, body: { ok: true, applied: true } });
  assert.equal((await hook({ id: 'evt_co', type: 'checkout.session.completed', data: { object: {} } })).body.duplicate, true, 'Stripe retries are applied once');
  assert.equal((await hook({ id: 'evt_other', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: 't_nobody', customer: 'cus_x' } } })).body.ignored, true);
  b = (await api.call('GET', '/api/billing', OWNER)).body.billing;
  assert.equal(b.subscribed, true); assert.equal(b.standing.status, 'active');
  assert.equal((await api.call('POST', '/api/billing/checkout', { ...OWNER, body: {} })).status, 409, 'already subscribed');
  assert.equal((await api.call('POST', '/api/billing/portal', { ...OWNER, body: {} })).body.url, 'https://billing.stripe.test/p/session_1');
  const log = (await api.call('GET', '/api/audit?action=billing.status', OWNER)).body.log;
  assert.match(log[0].detail, /none -> active \(Stripe checkout\.session\.completed evt_co\)/);

  const now = Math.floor(Date.now() / 1000);
  await hook({ id: 'evt_pd', type: 'customer.subscription.updated', created: now + 5, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'past_due' } } });
  await hook({ id: 'evt_old', type: 'customer.subscription.updated', created: now - 50, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active' } } });
  b = (await api.call('GET', '/api/billing', OWNER)).body.billing;
  assert.equal(b.standing.status, 'past_due', 'an older event arriving late does not win');
  assert.equal(b.standing.restrictsInDays, 15);
  assert.equal((await api.call('POST', '/api/users', { ...OWNER, body: { name: 'Still fine', groupIds: ['ug_staff'] } })).status, 200, 'grace period: nothing blocked yet');

  const scimOp = await api.call('POST', '/api/operators', { ...OWNER, body: { name: 'Entra', role: 'r_provisioner' } });
  await api.server.store.sql.batch([{ sql: 'UPDATE billing_accounts SET past_due_since = ? WHERE tenant_id = ?', params: [new Date(Date.now() - 16 * 864e5).toISOString(), tenantId] }]);
  const blocked = await api.call('POST', '/api/users', { ...OWNER, body: { name: 'New hire', groupIds: ['ug_staff'] } });
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.reason, 'billing_restricted');
  assert.match(blocked.body.error, /Removing access/);
  assert.equal((await api.call('POST', '/api/visit-invites', { ...OWNER, body: {} })).status, 402);
  const scim = await api.call('POST', '/scim/v2/Users', { token: scimOp.body.token, body: { userName: 'x@acme.example' }, contentType: 'application/scim+json' });
  assert.equal(scim.status, 402, 'directory sync cannot add people either');
  const users = (await api.call('GET', '/api/users', OWNER)).body.users;
  const victim = users.find(u => u.name === 'Still fine');
  assert.equal((await api.call('DELETE', `/api/users/${victim.id}`, OWNER)).status, 200, 'removing a person always works');
  assert.equal((await api.call('POST', `/api/users/${users.find(u => u.id === 'u1').id}/suspend`, { ...OWNER, body: {} })).status, 200, 'suspending always works');

  await hook({ id: 'evt_paid', type: 'customer.subscription.updated', created: now + 10, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active' } } });
  assert.equal((await api.call('POST', '/api/users', { ...OWNER, body: { name: 'New hire', groupIds: ['ug_staff'] } })).status, 200, 'paid: additions work again');
  assert.equal((await api.call('GET', '/api/billing', OWNER)).body.billing.standing.restrictsInDays, null);
});

test('usage: door-days from the connected fleet and SMS deltas, idempotent across Stripe outages', async t => {
  const { api, stripe, tenantId, hook } = await setup(t);
  const maintain = () => api.server.api.maintainOne(tenantId);
  assert.equal((await maintain()).billing, undefined, 'no subscription: nothing metered');
  await hook({ id: 'evt_co', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: tenantId, customer: 'cus_9', subscription: 'sub_9', payment_status: 'paid' } } });

  let m = await maintain();
  assert.deepEqual(m.billing, { doors: 0 }, 'demo doors are free (and nothing is sent for 0)');
  assert.equal(stripe.callsTo('/v1/billing/meter_events').length, 0);
  // Connect the real TTLock account (4 locks); a new day is simulated by dropping today's row.
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...OWNER, body: { region: 'eu', username: 'riverside-admin', password: 'river-pass-1' } })).status, 200);
  await api.server.store.sql.batch([{ sql: 'DELETE FROM billing_reports WHERE tenant_id = ?', params: [tenantId] }]);
  const today = new Date().toISOString().slice(0, 10);
  const p = today.slice(0, 7);
  await api.server.store.sql.batch([{ sql: "INSERT INTO usage_counters (tenant_id, period, kind, n) VALUES (?, ?, 'sms_segments', 7)", params: [tenantId, p] }]);
  stripe.failNext(1);
  m = await maintain();
  assert.match(m.billingError || '', /Stripe: simulated outage/);
  m = await maintain();
  assert.deepEqual(m.billing, { sent: 2 });
  const ev = stripe.callsTo('/v1/billing/meter_events');
  const ok = ev.slice(1);
  assert.deepEqual(ok.map(c => [c.params.event_name, c.params['payload[value]'], c.params['payload[stripe_customer_id]'], c.params.identifier]), [
    ['accessx_door_days', '4', 'cus_9', `${tenantId}:door_days:${today}`],
    ['accessx_sms_segments', '7', 'cus_9', `${tenantId}:sms_segments:${p}:7`],
  ]);
  assert.equal(ev[0].params.identifier, ok[0].params.identifier, 'the retry reuses the identifier: Stripe cannot count it twice');
  assert.equal(ok[0].headers['idempotency-key'], ok[0].params.identifier);
  assert.equal((await maintain()).billing, undefined, 'nothing new: nothing sent');
  await api.server.store.sql.batch([{ sql: "UPDATE usage_counters SET n = 10 WHERE tenant_id = ? AND kind = 'sms_segments'", params: [tenantId] }]);
  await maintain();
  const last = stripe.callsTo('/v1/billing/meter_events').at(-1);
  assert.deepEqual([last.params['payload[value]'], last.params.identifier], ['3', `${tenantId}:sms_segments:${p}:10`], 'only the new segments');
  const b = (await api.call('GET', '/api/billing', OWNER)).body.billing;
  assert.deepEqual(b.usage, { doorDays: 4, smsSegments: 10 });
  assert.equal(b.unsentReports, 0);
  const usage = await api.call('GET', '/api/platform/usage', { token: 'platform-token' });
  const mine = usage.body.tenants.find(x => x.tenantId === tenantId);
  assert.deepEqual([mine.doorDays, mine.smsSegments, mine.billing.status], [4, 10, 'active'], 'the platform sees what is billed');
});

test('billing off (default): no routes do anything, webhook is 404, nothing is gated', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  assert.deepEqual((await api.call('GET', '/api/billing', OWNER)).body.billing, { enabled: false });
  assert.equal((await api.call('POST', '/api/billing/checkout', { ...OWNER, body: {} })).status, 404);
  assert.equal((await fetch(`${api.base}/api/stripe/webhook`, { method: 'POST', body: '{}' })).status, 404);
});

test('operations: owner notice per stage, Stripe meter errors (thin events), stuck reports, platform alerts, estimate', async t => {
  const http = require('node:http');
  const got = [];
  const sink = http.createServer((req, res) => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => { got.push({ path: req.url, body: d }); res.writeHead(200); res.end('ok'); }); });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const sinkBase = `http://127.0.0.1:${sink.address().port}`;
  t.after(() => new Promise(r => sink.close(r)));
  const { api, stripe, tenantId, hook } = await setup(t, { ALLOW_HTTP_WEBHOOKS: '1', STRIPE_THIN_WEBHOOK_SECRET: 'whsec_thin', PLATFORM_ALERT_WEBHOOK: `${sinkBase}/platform` });
  const P = { token: 'platform-token' };
  const sql = api.server.store.sql;
  const tenantMsgs = () => got.filter(g => g.path === '/tenant').map(g => JSON.parse(g.body)).filter(x => x.type === 'accessx.alert.billing_problem').map(x => x.text || JSON.stringify(x));
  const platformMsgs = () => got.filter(g => g.path === '/platform').map(g => JSON.parse(g.body).text);
  const maintain = () => api.server.api.maintainOne(tenantId);
  const backdate = days => sql.batch([{ sql: 'UPDATE billing_accounts SET past_due_since = ? WHERE tenant_id = ?', params: [new Date(Date.now() - days * 864e5).toISOString(), tenantId] }]);
  stripe.setPrice('price_doors', { billing_scheme: 'per_unit', unit_amount_decimal: '40', currency: 'aud' });
  stripe.setPrice('price_sms', { billing_scheme: 'per_unit', unit_amount_decimal: '9.5', currency: 'aud' });
  assert.equal((await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: `${sinkBase}/tenant` } })).status, 200);

  let n = 0;
  const sub = async status => hook({ id: `evt_ops_${++n}`, type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000) + n, data: { object: { id: 'sub_ops', customer: 'cus_ops', status } } });
  await hook({ id: 'evt_ops_c', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: tenantId, customer: 'cus_ops', subscription: 'sub_ops', payment_status: 'paid' } } });
  assert.equal(tenantMsgs().length, 0, 'no notice while all is well');

  // estimate: Stripe's per-unit prices, shown per door-month
  const b = (await api.call('GET', '/api/billing', OWNER)).body.billing;
  assert.deepEqual([b.stage, b.estimate.currency, b.estimate.perDoorMonth, b.estimate.perSmsSegment, b.estimate.amount], ['ok', 'aud', 12, 0.095, 0]);

  // grace → paused → closure → sorted: one owner notice per stage, never repeated
  assert.equal((await sub('past_due')).status, 200);
  assert.match(tenantMsgs().at(-1), /last payment failed.*pauses in 15 day/);
  await sub('past_due');
  await maintain();
  assert.equal(tenantMsgs().length, 1, 'same stage: no second notice');
  await backdate(20);
  assert.equal((await maintain()).billingNotice, 'restricted');
  assert.match(tenantMsgs().at(-1), /adding people, visitors, codes and rules is paused/);
  await backdate(50);
  assert.equal((await maintain()).billingNotice, 'closure');
  assert.match(tenantMsgs().at(-1), /due for closure \(unpaid for 50 days\).*30 days' written notice/);
  assert.ok(platformMsgs().some(m => /\[closure_due\]/.test(m) && m.includes(tenantId)), 'the platform is told to close it by hand');
  assert.equal((await sub('active')).status, 200);
  assert.match(tenantMsgs().at(-1), /payment received/);
  assert.equal(tenantMsgs().length, 4);
  const log = (await api.call('GET', '/api/audit?limit=200', OWNER)).body.log.filter(e => e.action === 'billing.notice').map(e => e.detail.split(' (')[0]);
  assert.deepEqual(log.reverse(), ['ok -> grace', 'grace -> restricted', 'restricted -> closure', 'closure -> ok']);

  // Stripe rejected a meter event later (thin event from a second destination)
  await sql.batch([{ sql: 'INSERT INTO billing_reports (tenant_id, meter, report_key, value, event_at, sent_at) VALUES (?, ?, ?, ?, ?, ?)', params: [tenantId, 'door_days', '2026-09-01', 4, new Date().toISOString(), new Date().toISOString()] }]);
  const thin = { id: 'evt_thin_1', object: 'v2.core.event', type: 'v1.billing.meter.error_report_triggered', related_object: { id: 'mtr_1', type: 'billing.meter' } };
  assert.equal((await hook(thin, { secret: 'whsec_other' })).status, 400, 'unsigned / wrong secret');
  assert.equal((await hook(thin, { secret: 'whsec_thin' })).status, 502, 'details not fetchable yet: Stripe retries');
  stripe.setEvent('evt_thin_1', { type: thin.type, data: { developer_message_summary: 'There is 1 invalid event', reason: { error_count: 1, error_types: [{ code: 'meter_event_customer_not_found', error_count: 1, sample_errors: [{ error_message: 'No customer found for cus_ops', request: { identifier: `${tenantId}:door_days:2026-09-01` } }] }] } } });
  const ok = await hook(thin, { secret: 'whsec_thin' });
  assert.deepEqual([ok.status, ok.body.meterErrors], [200, 1]);
  assert.equal((await hook(thin, { secret: 'whsec_thin' })).body.duplicate, true);
  assert.match((await sql.first("SELECT error FROM billing_reports WHERE tenant_id = ? AND report_key = '2026-09-01'", [tenantId])).error, /customer_not_found/);
  assert.ok(platformMsgs().some(m => /\[meter_error\].*customer_not_found/.test(m)));

  // a report Stripe has not taken for a day
  await sql.batch([{ sql: 'INSERT INTO billing_reports (tenant_id, meter, report_key, value, event_at) VALUES (?, ?, ?, ?, ?)', params: [tenantId, 'sms_segments', '2026-09:3', 3, new Date(Date.now() - 2 * 864e5).toISOString()] }]);
  stripe.failNext(3);
  const m = await maintain();
  assert.match(m.billingError, /simulated outage/);
  assert.ok(platformMsgs().some(x => /\[unsent_reports\] .*1 usage report/.test(x)));

  // platform view: who needs a look, and resolving
  assert.equal((await api.call('GET', '/api/platform/billing', OWNER)).status, 401, 'tenants never see it');
  const pv = (await api.call('GET', '/api/platform/billing', P)).body.billing;
  assert.deepEqual(pv.problems.map(x => x.kind).sort(), ['closure_due', 'meter_error', 'unsent_reports']);
  assert.ok(pv.problems.every(x => x.notified), 'all were sent to PLATFORM_ALERT_WEBHOOK');
  const row = pv.tenants.find(x => x.tenantId === tenantId);
  assert.deepEqual([row.stage, row.reportErrors, row.unsentReports], ['ok', 1, 1]);
  const key = pv.problems.find(x => x.kind === 'meter_error').key;
  assert.equal((await api.call('POST', `/api/platform/billing/problems/${encodeURIComponent(key)}/resolve`, { ...P, body: { note: 'customer re-linked' } })).status, 200);
  assert.equal((await api.call('GET', '/api/platform/billing', P)).body.billing.problems.length, 2);
  const sent = platformMsgs().length;
  await maintain();
  assert.equal(platformMsgs().length, sent, 'nothing is sent twice');
});
