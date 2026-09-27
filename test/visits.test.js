const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');
const visitors = require('../visitors-core');
const creds = require('../credentials-core');

const OWNER = { token: 'owner-token' };
const M1 = { token: 'm1-token' };
const DESK = { token: 'desk-token' };
const GYM_DESK = { token: 'gym-desk-token' };
const SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');
const OPERATORS = JSON.stringify([
  { id: 'op_m1', name: 'Manager One', role: 'r_manager', tokenSha256: sha256Hex('m1-token') },
  { id: 'op_desk', name: 'Reception', role: 'r_front_desk', siteIds: ['site_river'], tokenSha256: sha256Hex('desk-token') },
  { id: 'op_gdesk', name: 'Gym reception', role: 'r_front_desk', siteIds: ['site_gym'], tokenSha256: sha256Hex('gym-desk-token') },
]);
const MARKER = 'Vera Visitorova';

/** The calendar date at the door (Europe/London) `days` from now. */
const londonDate = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 864e5));

async function setup(t, env = {}) {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, RECONCILE_INTERVAL_MIN: '0', SECRETS_KEY, ...env });
  t.after(api.close);
  const vendor = api.server.vendorFor('t_default');
  const sent = [];
  const create = vendor.createPasscode;
  vendor.createPasscode = async o => { sent.push(o); return create.call(vendor, o); };
  t.after(() => { vendor.createPasscode = create; });
  return { api, vendor, sent };
}

const visitBody = (extra = {}) => ({
  visitorName: MARKER, visitorEmail: 'vera@guest.example', company: 'Acme Audit', hostUserId: 'u1',
  lockIds: [9001], startLocal: `${londonDate(2)}T09:30`, endLocal: `${londonDate(2)}T17:10`, ...extra,
});

/** Records what an email provider receives; replies with the scripted statuses in order. */
async function provider(t, statuses) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { got.push({ path: req.url, headers: req.headers, body: JSON.parse(b || '{}') }); res.writeHead(statuses[Math.min(got.length - 1, statuses.length - 1)]); res.end('{"id":"x"}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, got };
}

test('front desk registers a visitor: whole-hour window, codes shown once, no personal data in the audit chain or at the lock vendor', async t => {
  const { api, sent } = await setup(t);
  const hosts = await api.call('GET', '/api/visits/hosts', DESK);
  assert.equal(hosts.status, 200);
  assert.ok(hosts.body.hosts.some(h => h.id === 'u1'));
  assert.ok(!hosts.body.hosts.some(h => h.id === 'u5'), 'suspended people cannot host');
  assert.deepEqual(Object.keys(hosts.body.hosts[0]).sort(), ['id', 'name'], 'just enough to pick a host');

  const r = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ lockIds: [9001, 9003] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body.visit;
  assert.match(v.id, /^vis/);
  assert.equal(v.state, 'scheduled');
  // 09:30–17:10 at the door → 09:00–18:00 (BST or GMT depending on the date: compare on the door clock).
  const local = iso => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  assert.equal(local(v.startAt), '09:00');
  assert.equal(local(v.endAt), '18:00');
  assert.equal(r.body.warnings.filter(w => /whole hours/.test(w)).length, 2, 'the operator sees both roundings');
  assert.equal(r.body.codes.length, 2);
  assert.deepEqual(r.body.codes.map(c => c.door), ['Main Entrance', 'Warehouse Side Door']);
  assert.ok(r.body.codes.every(c => /^\d{6}$/.test(c.code)));
  assert.equal(r.body.delivery, 'shown');
  assert.deepEqual(sent.map(s => [s.lockId, s.startAt, s.endAt]), [[9001, v.startAt, v.endAt], [9003, v.startAt, v.endAt]], 'the lock enforces exactly the recorded window');
  assert.ok(sent.every(s => s.name === `AccessX visit ${v.id}`), 'only the visit id goes to the lock vendor');

  const list = await api.call('GET', '/api/visits', DESK);
  const row = list.body.visits.find(x => x.id === v.id);
  assert.equal(row.visitorName, MARKER);
  assert.equal(row.hostName, 'Sarah Kelly');
  assert.deepEqual(row.codes.map(c => c.status), ['active', 'active']);
  assert.ok(!JSON.stringify(list.body).includes(r.body.codes[0].code), 'the code is never shown again');

  const all = await api.call('GET', '/api/credentials', OWNER);
  const mine = all.body.credentials.filter(c => c.visitId === v.id);
  assert.equal(mine.length, 2);
  assert.ok(mine.every(c => c.userId === 'u1' && c.enforcement === 'lock' && /visitor \(host Sarah Kelly\)/.test(c.rules[0])));
  assert.deepEqual(all.body.review.filter(f => mine.some(c => c.id === f.id)), [], 'visitor codes are not flagged for lacking a rule');

  const audit = await api.call('GET', '/api/audit/export', OWNER);
  const text = typeof audit.body === 'string' ? audit.body : JSON.stringify(audit.body);
  assert.match(text, new RegExp(`visit\\.create.*${v.id}`));
  for (const pii of [MARKER, 'vera@guest.example', 'Acme Audit']) assert.ok(!text.includes(pii), `audit chain must not contain ${pii}`);
  for (const c of r.body.codes) assert.ok(!text.includes(c.code), 'nor the codes');

  // The front desk can do visitors and nothing else.
  assert.equal((await api.call('GET', '/api/credentials', DESK)).status, 403);
  assert.equal((await api.call('POST', '/api/passcode', { ...DESK, body: { lockId: 9001, userId: 'u1' } })).status, 403);
  assert.equal((await api.call('GET', '/api/users', DESK)).status, 403);
  assert.equal((await api.call('PUT', '/api/visits/settings', { ...DESK, body: { maxHours: 48 } })).status, 403);
  // Managers can (credential.issue implies visitor.manage).
  assert.equal((await api.call('GET', '/api/visits', M1)).status, 200);
});

test('refused: sensitive doors, mixed sites, other sites, unknown/suspended hosts, too long, over, unknown locks', async t => {
  const { api, sent } = await setup(t);
  const dg = await api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Server room', siteId: 'site_river', lockIds: [9002], sensitive: true } });
  assert.equal(dg.status, 200);
  const doors = (await api.call('GET', '/api/doors', DESK)).body.doors;
  assert.deepEqual(doors.filter(d => d.sensitive).map(d => d.lockId), [9002], 'the form can grey out sensitive doors');
  assert.ok(doors.every(d => d.siteId === 'site_river'));
  const roles = (await api.call('GET', '/api/permissions', OWNER)).body.roles;
  assert.ok(roles.some(r => r.id === 'r_front_desk' && r.builtIn), 'assignable in tenants seeded before the role existed');
  const post = (body, who = DESK) => api.call('POST', '/api/visits', { ...who, body: visitBody(body) });
  const sens = await post({ lockIds: [9001, 9002] });
  assert.equal(sens.status, 409);
  assert.equal(sens.body.reason, 'sensitive_door');
  assert.equal((await post({ lockIds: [9001, 9101] }, OWNER)).status, 400, 'one site per visit');
  assert.equal((await post({ lockIds: [9101] })).status, 403, 'river reception cannot open the gym');
  assert.equal((await post({ lockIds: [424242] })).status, 404, 'not this tenant\'s lock');
  assert.equal((await post({ lockIds: [9001, 9003, 9004, 9001, 9003] })).status, 200, 'duplicates collapse');
  assert.equal((await post({ lockIds: [] })).status, 400);
  assert.equal((await post({ hostUserId: 'nobody' })).status, 404);
  assert.equal((await post({ hostUserId: 'u5' })).status, 409, 'suspended host');
  assert.equal((await post({ hostUserId: 'u4' }, GYM_DESK)).status, 403, 'gym desk: river door');
  assert.equal((await post({ hostUserId: 'u1', lockIds: [9101] }, GYM_DESK)).status, 404, 'gym desk cannot see a river host');
  assert.equal((await post({ visitorName: '  ' })).status, 400);
  assert.equal((await post({ visitorEmail: 'vera@guest.example\r\nBcc: x@y.example' })).status, 400, 'no header injection');
  assert.equal((await post({ endLocal: `${londonDate(3)}T17:00` })).status, 400, 'over the 24 h default');
  assert.equal((await post({ startLocal: `${londonDate(-3)}T09:00`, endLocal: `${londonDate(-3)}T17:00` })).status, 400, 'already over');
  assert.equal((await post({ startLocal: `${londonDate(40)}T09:00`, endLocal: `${londonDate(40)}T17:00` })).status, 400, 'too far ahead');
  assert.equal((await post({ endLocal: `${londonDate(2)}T08:00` })).status, 400, 'ends before it starts');
  assert.equal((await post({ endLocal: 'tomorrow' })).status, 400);
  assert.equal(sent.length, 3, 'nothing reached a lock except the one valid visit (3 doors)');

  // No start = now; end today/tomorrow within the limit.
  const in6h = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(Date.now() + 6 * 36e5)).replace(' ', 'T');
  const now = await post({ startLocal: undefined, endLocal: in6h });
  assert.equal(now.status, 200, JSON.stringify(now.body));
  assert.equal(now.body.visit.state, 'active');
});

test('checkout revokes over the gateway; a door without gateway is reported honestly; a failed delete leaves the visit open for a retry', async t => {
  const { api, vendor } = await setup(t);
  const r = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ lockIds: [9001, 9004] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.visit.id;

  const del = vendor.deletePasscode;
  vendor.deletePasscode = async () => { const e = new Error('gateway timeout'); e.status = 503; throw e; };
  const fail = await api.call('POST', `/api/visits/${id}/checkout`, { ...DESK, body: {} });
  assert.ok(fail.status >= 500, `delete failure surfaces (${fail.status})`);
  let row = (await api.call('GET', '/api/visits', DESK)).body.visits.find(x => x.id === id);
  assert.equal(row.status, 'scheduled', 'visit stays open');
  assert.deepEqual(row.codes.map(c => [c.lockId, c.status]), [[9001, 'active'], [9004, 'pending_removal']], 'progress kept');
  vendor.deletePasscode = del;

  const ok = await api.call('POST', `/api/visits/${id}/checkout`, { ...DESK, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.visit.state, 'checked_out');
  assert.deepEqual(ok.body.visit.codes.map(c => [c.lockId, c.status]), [[9001, 'revoked'], [9004, 'pending_removal']]);
  assert.equal((await api.call('POST', `/api/visits/${id}/checkout`, { ...DESK, body: {} })).status, 409);
  assert.equal((await api.call('POST', `/api/visits/${id}/cancel`, { ...DESK, body: {} })).status, 409);
  assert.equal((await api.call('POST', `/api/visits/${id}/checkout`, { ...GYM_DESK, body: {} })).status, 404, 'other site: does not exist');
  assert.ok(!(await api.call('GET', '/api/visits', GYM_DESK)).body.visits.some(x => x.id === id));

  // A cancelled visit whose doors all have gateways leaves nothing behind.
  const c = await api.call('POST', '/api/visits', { ...DESK, body: visitBody() });
  const cancelled = await api.call('POST', `/api/visits/${c.body.visit.id}/cancel`, { ...DESK, body: {} });
  assert.equal(cancelled.body.visit.state, 'cancelled');
  assert.deepEqual(cancelled.body.stillValid, []);
  const log = (await api.call('GET', '/api/audit?action=credential.revoke', OWNER)).body.log;
  assert.ok(log.some(e => e.detail.includes(`visit ${c.body.visit.id}`)));
});

test('visitor codes follow the host: suspending the host revokes them', async t => {
  const { api } = await setup(t);
  const r = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ hostUserId: 'u2' }) });
  assert.equal(r.status, 200);
  assert.equal((await api.call('POST', '/api/users/u2/suspend', OWNER)).status, 200);
  const row = (await api.call('GET', '/api/visits', OWNER)).body.visits.find(x => x.id === r.body.visit.id);
  assert.deepEqual(row.codes.map(c => c.status), ['revoked']);
});

test('a vendor failure halfway leaves no untracked code on a lock', async t => {
  const { api, vendor } = await setup(t);
  const create = vendor.createPasscode;
  let n = 0;
  const deleted = [];
  vendor.createPasscode = async o => { if (++n === 2) throw Object.assign(new Error('TTLock down'), { status: 503 }); return create(o); };
  const del = vendor.deletePasscode;
  vendor.deletePasscode = async (lockId, ref) => { deleted.push(lockId); return del.call(vendor, lockId, ref); };
  t.after(() => { vendor.createPasscode = create; vendor.deletePasscode = del; });
  const r = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ lockIds: [9001, 9003] }) });
  assert.ok(r.status >= 500);
  assert.deepEqual(deleted, [9001], 'the code already on 9001 was removed');
  const creds = (await api.call('GET', '/api/credentials', OWNER)).body.credentials.filter(c => c.visitId);
  assert.deepEqual(creds.map(c => [c.lockId, c.status, c.revokeReason]), [[9001, 'revoked', 'visit creation failed']]);
  assert.equal((await api.call('GET', '/api/visits?range=all', OWNER)).body.visits.length, 0, 'no visit');
});

test('email: the code goes to the visitor once, never through the retry outbox; a failed send falls back to the screen', async t => {
  const mail = await provider(t, [200, 500]);
  const { api } = await setup(t, { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'Front desk <desk@accessx.example>', EMAIL_API_BASE: mail.base });
  assert.equal((await api.call('GET', '/api/visits/settings', DESK)).body.emailAvailable, true);
  const r = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ sendCode: true }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.delivery, 'emailed');
  assert.equal(mail.got.length, 1);
  const m = mail.got[0];
  assert.deepEqual(m.body.to, ['vera@guest.example']);
  assert.equal(m.headers['idempotency-key'], `accessx-visit-${r.body.visit.id}`);
  assert.match(m.body.subject, /Riverside Office/);
  assert.match(m.body.text, new RegExp(`Hello ${MARKER}`));
  assert.match(m.body.text, new RegExp(`Main Entrance: ${r.body.codes[0].code}`));
  assert.match(m.body.text, /Sarah Kelly has invited you/);
  const outbox = api.server.store.sql.all ? await api.server.store.sql.all('SELECT message FROM alert_outbox') : [];
  assert.ok(!JSON.stringify(outbox).includes(r.body.codes[0].code), 'the code is not stored in the outbox');

  const f = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ sendCode: true }) });
  assert.equal(f.status, 200);
  assert.equal(f.body.delivery, 'email_failed');
  assert.equal(f.body.codes.length, 1, 'the code is still shown');
  assert.ok(f.body.warnings.some(w => /hand the code over/.test(w)));
  assert.equal(mail.got.length, 2, 'one attempt, no retry of a message with a code');

  const noEmail = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ sendCode: true, visitorEmail: '' }) });
  assert.equal(noEmail.body.delivery, 'shown');
  assert.ok(noEmail.body.warnings.some(w => /no visitor email/.test(w)));
});

test('email not configured: warning, code shown', async t => {
  const { api } = await setup(t);
  const r = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ sendCode: true }) });
  assert.equal(r.body.delivery, 'shown');
  assert.ok(r.body.warnings.some(w => /not configured/.test(w)));
});

test('personal data: erased on request, and automatically after the retention period; settings are owner-only and bounded', async t => {
  const { api } = await setup(t);
  const a = await api.call('POST', '/api/visits', { ...DESK, body: visitBody() });
  const b = await api.call('POST', '/api/visits', { ...DESK, body: visitBody() });
  const er = await api.call('POST', `/api/visits/${a.body.visit.id}/erase`, { ...DESK, body: {} });
  assert.equal(er.status, 200);
  assert.equal(er.body.visit.visitorName, null);
  assert.equal(er.body.visit.erased, true);
  assert.equal(er.body.visit.codes.length, 1, 'the visit record itself stays');

  assert.equal((await api.call('PUT', '/api/visits/settings', { ...OWNER, body: { retentionDays: 0 } })).status, 400);
  assert.equal((await api.call('PUT', '/api/visits/settings', { ...OWNER, body: { maxHours: 500 } })).status, 400);
  assert.equal((await api.call('PUT', '/api/visits/settings', { ...M1, body: { retentionDays: 7 } })).status, 403);
  const s = await api.call('PUT', '/api/visits/settings', { ...OWNER, body: { retentionDays: 7, maxHours: 72 } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.retentionDays, 7);

  // A three-day visit is now allowed — and the 24 h first-use rule is spelled out.
  const long = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ startLocal: `${londonDate(2)}T09:00`, endLocal: `${londonDate(4)}T17:00` }) });
  assert.equal(long.status, 200, JSON.stringify(long.body));
  assert.ok(long.body.warnings.some(w => /within 24 h of its start/.test(w)));

  // Age visit b past the retention period.
  const old = new Date(Date.now() - 8 * 864e5).toISOString();
  await api.server.store.sql.batch([{ sql: 'UPDATE visits SET start_at = ?, end_at = ? WHERE id = ?', params: [old, old, b.body.visit.id] }]);
  const m = await api.server.api.maintenance();
  assert.equal(m.find(x => x.tenantId === 't_default').visitsErased, 1);
  const rows = (await api.call('GET', '/api/visits?range=all', OWNER)).body.visits;
  assert.equal(rows.find(x => x.id === b.body.visit.id).visitorName, null);
  assert.equal(rows.find(x => x.id === long.body.visit.id).visitorName, MARKER, 'current visits keep their details');
  const log = (await api.call('GET', '/api/audit?action=visits.erased', OWNER)).body.log;
  assert.match(log[0].detail, /1 visit\(s\) ended more than 7 days ago/);
  assert.equal((await api.server.api.maintenance()).find(x => x.tenantId === 't_default').visitsErased, undefined, 'idempotent');
});

test('core: settings bounds and state', () => {
  assert.deepEqual(visitors.settingsOf({}), { maxHours: 24, retentionDays: 30, notifyHost: true });
  assert.deepEqual(visitors.settingsOf({ visitors: { maxHours: 999, retentionDays: 3, notifyHost: false } }), { maxHours: 24, retentionDays: 3, notifyHost: false });
  const v = { status: 'scheduled', startAt: '2026-10-05T08:00:00Z', endAt: '2026-10-05T17:00:00Z' };
  assert.equal(visitors.stateOf(v, Date.parse('2026-10-05T07:00:00Z')), 'scheduled');
  assert.equal(visitors.stateOf(v, Date.parse('2026-10-05T09:00:00Z')), 'active');
  assert.equal(visitors.stateOf(v, Date.parse('2026-10-05T18:00:00Z')), 'ended');
  assert.equal(visitors.stateOf({ ...v, status: 'cancelled' }, 0), 'cancelled');
  // Review: a visitor code follows its host, not rules.
  const db = { users: [{ id: 'h', groupIds: [] }], credentials: [{ id: 'c1', status: 'active', userId: 'h', lockId: 1, visitId: 'vis1', endAt: '2999-01-01T00:00:00Z' }] };
  assert.deepEqual(creds.reviewCredentials(db), []);
  db.users[0].suspended = true;
  assert.deepEqual(creds.reviewCredentials(db).map(f => f.reasons), [['host suspended']]);
  db.users = [];
  assert.deepEqual(creds.reviewCredentials(db).map(f => f.reasons), [['host deleted']]);
});

// ---- arrival: TTLock record callback / polling ---------------------------------------
const NOTIFY = 'notify-secret-9f2c';
const notify = (api, records, secret = NOTIFY) => fetch(`${api.base}/api/ttlock/notify/${secret}`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ lockId: String(records[0] ? records[0].lockId : ''), notifyType: '1', records: JSON.stringify(records), admin: 'owner@x.example' }),
}).then(async r => ({ status: r.status, text: await r.text() }));
const rec = (lockId, code, at, extra = {}) => ({ lockId, recordType: 4, success: 1, keyboardPwd: code, lockDate: at, serverDate: at, username: 'x', electricQuantity: 80, ...extra });

test('arrival: the first unlock with the visitor\'s code (TTLock callback) is recorded once and the host is emailed', async t => {
  const mail = await provider(t, [200]);
  const { api } = await setup(t, { TTLOCK_NOTIFY_SECRET: NOTIFY, EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'desk@accessx.example', EMAIL_API_BASE: mail.base });
  const s = await api.call('GET', '/api/visits/settings', DESK);
  assert.deepEqual(s.body.arrivals, { enabled: true, callback: true });
  const r = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ lockIds: [9001, 9003] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.visit.id;
  const code = r.body.codes[0].code;
  const inWindow = Date.parse(r.body.visit.startAt) + 36e5;
  const row = await api.server.store.sql.first('SELECT code_macs FROM visits WHERE id = ?', [id]);
  assert.ok(!row.code_macs.includes(code), 'fingerprints, not codes');
  assert.deepEqual(Object.keys(JSON.parse(row.code_macs)).sort(), ['9001', '9003']);

  assert.equal((await notify(api, [rec(9001, code, inWindow)], 'wrong-secret')).status, 404);
  const other = String((Number(code) + 1) % 1e6).padStart(6, '0');
  for (const [records, why] of [
    [[rec(9001, other, inWindow)], 'another code'],
    [[rec(9002, code, inWindow)], 'the code on a door that is not part of the visit'],
    [[rec(9001, code, Date.parse(r.body.visit.startAt) - 60e3)], 'before the visit'],
    [[rec(9001, code, inWindow, { success: 0 })], 'a failed attempt'],
    [[rec(9001, code, inWindow, { recordType: 7 })], 'not a passcode unlock'],
  ]) {
    const n = await notify(api, records);
    assert.equal(n.status, 200, why);
    assert.equal(n.text, 'success', 'TTLock expects "success"');
  }
  assert.equal((await api.call('GET', '/api/visits', DESK)).body.visits.find(v => v.id === id).arrivedAt, null);
  assert.equal(mail.got.length, 0);

  // The real arrival: several records in one callback, the earliest wins.
  await notify(api, [rec(9003, r.body.codes[1].code, inWindow + 60e3), rec(9001, code, inWindow)]);
  const v = (await api.call('GET', '/api/visits', DESK)).body.visits.find(x => x.id === id);
  assert.equal(v.arrivedAt, new Date(inWindow).toISOString());
  assert.equal(v.arrivedLock, 9001);
  assert.equal(mail.got.length, 1);
  assert.deepEqual(mail.got[0].body.to, ['sarah@acme.co.uk'], 'the host (u1)');
  assert.match(mail.got[0].body.subject, new RegExp(`${MARKER} \\(Acme Audit\\) has arrived`));
  assert.match(mail.got[0].body.text, /opened Main Entrance at/);
  assert.equal(mail.got[0].headers['idempotency-key'], `accessx-arrival-${id}`);
  // Once.
  await notify(api, [rec(9001, code, inWindow + 5 * 60e3)]);
  assert.equal(mail.got.length, 1);
  const log = (await api.call('GET', '/api/audit?action=visit.arrived', OWNER)).body.log;
  assert.equal(log.length, 1);
  assert.equal(log[0].detail, `${id} lock 9001 at ${new Date(inWindow).toISOString()} via callback`);
  assert.ok(!JSON.stringify(log).includes(MARKER));
  // Checked-out visits are not "arrived" afterwards.
  const r2 = await api.call('POST', '/api/visits', { ...DESK, body: visitBody() });
  await api.call('POST', `/api/visits/${r2.body.visit.id}/cancel`, { ...DESK, body: {} });
  await notify(api, [rec(9001, r2.body.codes[0].code, inWindow)]);
  assert.equal((await api.call('GET', '/api/visits', DESK)).body.visits.find(x => x.id === r2.body.visit.id).arrivedAt, null);
  // Host notification can be switched off by an owner.
  assert.equal((await api.call('PUT', '/api/visits/settings', { ...OWNER, body: { notifyHost: 'yes' } })).status, 400);
  assert.equal((await api.call('PUT', '/api/visits/settings', { ...OWNER, body: { notifyHost: false } })).body.notifyHost, false);
  const r3 = await api.call('POST', '/api/visits', { ...DESK, body: visitBody() });
  await notify(api, [rec(9001, r3.body.codes[0].code, inWindow)]);
  assert.ok((await api.call('GET', '/api/visits', DESK)).body.visits.find(x => x.id === r3.body.visit.id).arrivedAt);
  assert.equal(mail.got.length, 1, 'no email when switched off');
});

test('arrival without the callback: maintenance reads recent records of doors with a visitor on site', async t => {
  const { api, vendor } = await setup(t);
  assert.equal((await notify(api, [])).status, 404, 'callback disabled without TTLOCK_NOTIFY_SECRET');
  const in6h = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(Date.now() + 6 * 36e5)).replace(' ', 'T');
  const r = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ startLocal: undefined, endLocal: in6h, lockIds: [9001, 9004] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const asked = [];
  const records = vendor.records;
  vendor.records = async lockId => { asked.push(Number(lockId)); return Number(lockId) === 9001 ? [rec(9001, '000000', Date.now() - 120e3), rec(9001, r.body.codes[0].code, Date.now() - 60e3)] : []; };
  t.after(() => { vendor.records = records; });
  const m = await api.server.api.maintenance();
  assert.equal(m.find(x => x.tenantId === 't_default').arrivals, 1);
  assert.deepEqual(asked, [9001], 'only doors with a gateway (9004 has none)');
  const v = (await api.call('GET', '/api/visits', DESK)).body.visits.find(x => x.id === r.body.visit.id);
  assert.equal(v.arrivedLock, 9001);
  assert.match((await api.call('GET', '/api/audit?action=visit.arrived', OWNER)).body.log[0].detail, /via records$/);
  asked.length = 0;
  await api.server.api.maintenance();
  assert.deepEqual(asked, [], 'arrived visits are not polled again');
});

test('code fingerprints: bound to tenant and lock, verifiable under every key in the ring, useless without the key', async () => {
  const { codeMac, codeMacs } = require('../secrets-core');
  const k1 = Buffer.alloc(32, 1).toString('base64');
  const k2 = Buffer.alloc(32, 2).toString('base64');
  const a = await codeMac(k1, { tenantId: 't1', lockId: 9001, code: '123456' });
  assert.match(a, /^[0-9a-f]{16}:[0-9a-f]{32}$/);
  assert.notEqual(await codeMac(k1, { tenantId: 't2', lockId: 9001, code: '123456' }), a, 'other tenant');
  assert.notEqual(await codeMac(k1, { tenantId: 't1', lockId: 9002, code: '123456' }), a, 'other lock');
  assert.notEqual(await codeMac(k2, { tenantId: 't1', lockId: 9001, code: '123456' }), a, 'other key');
  // After rotation (new key first) the old fingerprint still matches.
  assert.ok((await codeMacs(`${k2},${k1}`, { tenantId: 't1', lockId: 9001, code: '123456' })).includes(a));
  assert.equal(await codeMac('', { tenantId: 't1', lockId: 9001, code: '123456' }), null);
  // Arrival candidates: only successful passcode unlocks with a plausible code.
  assert.deepEqual(visitors.arrivalCandidates([rec(1, '123456', 5), rec(1, '12', 5), rec(1, '123456', 5, { recordType: 1 }), { junk: true }, null]).map(r => r.code), ['123456']);
});

test('visitor_arrived alerts are opt-in (they name people)', async t => {
  const { api } = await setup(t);
  const a = await api.call('GET', '/api/alerts', OWNER);
  assert.ok(!a.body.alerts.events.includes('visitor_arrived'));
  assert.ok(a.body.alerts.events.includes('removal_overdue'));
  const on = await api.call('PUT', '/api/alerts', { ...OWNER, body: { events: ['removal_overdue', 'visitor_arrived'] } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(on.body.alerts.events, ['removal_overdue', 'visitor_arrived']);
});

// ---- SMS (Twilio) -------------------------------------------------------------------
async function twilio(t, statuses) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { got.push({ path: req.url, headers: req.headers, form: Object.fromEntries(new URLSearchParams(b)) }); res.writeHead(statuses[Math.min(got.length - 1, statuses.length - 1)], { 'content-type': 'application/json' }); res.end('{"sid":"SMx","status":"queued"}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, got };
}
const TWILIO_ENV = base => ({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC0123456789abcdef0123456789abcdef', TWILIO_AUTH_TOKEN: 'tw-token', SMS_FROM: '+447700900000', SMS_API_BASE: base });

test('SMS: the code is texted once (no visitor name in the text), a failed text falls back to the screen, phones are validated and erased', async t => {
  const tw = await twilio(t, [201, 500, 201]);
  const mail = await provider(t, [200]);
  const { api } = await setup(t, { ...TWILIO_ENV(tw.base), EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'desk@accessx.example', EMAIL_API_BASE: mail.base });
  assert.equal((await api.call('GET', '/api/visits/settings', DESK)).body.smsAvailable, true);
  assert.equal((await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ visitorPhone: '07700 900123' }) })).status, 400, 'international format required');

  const r = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ visitorPhone: '+44 7700 900-123', sendSms: true, lockIds: [9001, 9003] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.delivery, 'texted');
  assert.equal(r.body.visit.visitorPhone, '+447700900123', 'normalised');
  const m = tw.got[0];
  assert.equal(m.path, '/2010-04-01/Accounts/AC0123456789abcdef0123456789abcdef/Messages.json');
  assert.equal(m.headers.authorization, `Basic ${Buffer.from('AC0123456789abcdef0123456789abcdef:tw-token').toString('base64')}`);
  assert.equal(m.form.To, '+447700900123');
  assert.equal(m.form.From, '+447700900000');
  assert.match(m.form.Body, new RegExp(`^Riverside Office: door codes Main Entrance ${r.body.codes[0].code}, Warehouse Side Door ${r.body.codes[1].code} valid`));
  assert.ok(!m.form.Body.includes(MARKER), 'no name in a text that may be read on a lock screen');
  assert.ok(m.form.Body.length <= 320, `two segments at most (${m.form.Body.length})`);
  const log = (await api.call('GET', '/api/audit?action=visit.code_texted', OWNER)).body.log;
  assert.equal(log[0].detail, r.body.visit.id);
  assert.ok(!JSON.stringify(log).includes('7700'), 'no phone number in the audit chain');

  const f = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ visitorPhone: '+447700900123', sendSms: true }) });
  assert.equal(f.body.delivery, 'sms_failed');
  assert.equal(f.body.codes.length, 1);
  assert.ok(f.body.warnings.some(w => /text message could not be sent/.test(w)));
  assert.equal(tw.got.length, 2, 'no retry');

  const both = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ visitorPhone: '+447700900123', sendSms: true, sendCode: true }) });
  assert.equal(both.body.delivery, 'emailed+texted');
  const noPhone = await api.call('POST', '/api/visits', { ...DESK, body: visitBody({ sendSms: true }) });
  assert.ok(noPhone.body.warnings.some(w => /no visitor phone/.test(w)));

  const er = await api.call('POST', `/api/visits/${r.body.visit.id}/erase`, { ...DESK, body: {} });
  assert.equal(er.body.visit.visitorPhone, null);
  const row = await api.server.store.sql.first('SELECT visitor_phone FROM visits WHERE id = ?', [r.body.visit.id]);
  assert.equal(row.visitor_phone, null);
});

test('SMS config and helpers', () => {
  const { smsConfigFromEnv, normalizePhone, smsRequest } = require('../sms-core');
  assert.equal(smsConfigFromEnv({}), null);
  assert.throws(() => smsConfigFromEnv({ SMS_PROVIDER: 'nexmo' }), /twilio/);
  assert.throws(() => smsConfigFromEnv({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1' }), /SMS_FROM/);
  const key = smsConfigFromEnv({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_API_KEY: 'SK1', TWILIO_API_SECRET: 's', SMS_FROM: 'MG0123456789abcdef0123456789abcdef' });
  assert.equal(key.username, 'SK1');
  const req = smsRequest(key, '+15558675310', 'hi');
  assert.match(req.body, /MessagingServiceSid=MG0123456789abcdef0123456789abcdef/);
  assert.ok(!/From=/.test(req.body), 'From must be empty with a Messaging Service');
  assert.equal(normalizePhone('+1 (555) 867-5310'), '+15558675310');
  for (const bad of ['5558675310', '+0123456789', '+12', 'call me']) assert.equal(normalizePhone(bad), null, bad);
});
