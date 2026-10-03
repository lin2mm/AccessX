// R15 self-service signup and demo reset (docs/21-SIGNUP.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot } = require('../support/boot');

const PLATFORM = 'platform-token-for-signup-tests-0123456789';

/** Fake Resend: records every email. */
async function mailbox(t, statuses = [200]) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { got.push(JSON.parse(b || '{}')); res.writeHead(statuses[Math.min(got.length - 1, statuses.length - 1)], { 'content-type': 'application/json' }); res.end('{"id":"e"}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, got };
}
async function setup(t, { statuses, env = {} } = {}) {
  const mail = await mailbox(t, statuses);
  const api = await boot({ ADMIN_TOKEN: 'owner-token', PLATFORM_TOKEN: PLATFORM, RECONCILE_INTERVAL_MIN: '0', PUBLIC_URL: 'https://doors.example',
    EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'hello@accessx.example', EMAIL_API_BASE: mail.base, SIGNUP_ENABLED: '1', ...env });
  t.after(api.close);
  return { api, mail };
}
const post = (api, path, body) => fetch(`${api.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json(), headers: r.headers }));
const form = (extra = {}) => ({ company: 'Harbour Studio', name: 'Maya Chen', email: 'Maya@Harbour.example', timeZone: 'Australia/Sydney', acceptTerms: true, ...extra });
const linkToken = mail => (mail.text.match(/signup#t=([A-Za-z0-9_-]+)/) || [])[1];

test('signup is off unless SIGNUP_ENABLED=1 with email and PUBLIC_URL', async t => {
  const off = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(off.close);
  assert.equal((await off.call('GET', '/api/signup')).body.enabled, false);
  assert.equal((await post(off, '/api/signup', form())).status, 404);
  assert.equal((await post(off, '/api/signup/verify', { token: 'x'.repeat(40) })).status, 404);
  const noMail = await boot({ ADMIN_TOKEN: 'owner-token', SIGNUP_ENABLED: '1', PUBLIC_URL: 'https://doors.example' });
  t.after(noMail.close);
  assert.equal((await noMail.call('GET', '/api/signup')).body.enabled, false);
  assert.equal((await post(noMail, '/api/signup', form())).status, 404);
});

test('signup → emailed link → a new tenant with its owner; the link works once; nothing of the default tenant leaks', async t => {
  const { api, mail } = await setup(t);
  assert.equal((await api.call('GET', '/api/signup')).body.enabled, true);
  const r = await post(api, '/api/signup', form());
  assert.equal(r.status, 200);
  assert.match(r.body.message, /Check your inbox/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(mail.got.length, 1);
  assert.deepEqual(mail.got[0].to, ['maya@harbour.example']);
  assert.match(mail.got[0].subject, /Harbour Studio/);
  const token = linkToken(mail.got[0]);
  assert.ok(token && token.length >= 40, mail.got[0].text);
  assert.match(mail.got[0].text, /^https:\/\/doors\.example\/signup#t=/m);

  // Nothing exists until the link is opened.
  const before = (await api.call('GET', '/api/tenants', { token: PLATFORM })).body.tenants.length;
  const v = await post(api, '/api/signup/verify', { token });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.tenant.name, 'Harbour Studio');
  const owner = v.body.owner.token;
  assert.match(owner, /^ax_/);
  assert.equal((await api.call('GET', '/api/tenants', { token: PLATFORM })).body.tenants.length, before + 1);

  const me = await api.call('GET', '/api/me', { token: owner });
  assert.equal(me.status, 200);
  assert.equal(me.body.tenant.id, v.body.tenant.id);
  assert.equal(me.body.operator.role, 'r_owner');
  assert.equal((await api.call('GET', '/api/users', { token: owner })).body.users.length, 0, 'an empty account, not the demo data');
  assert.equal((await api.call('GET', '/api/doors', { token: owner })).body.doors.length, 0, 'no doors until TTLock is connected');
  const audit = (await api.call('GET', '/api/audit?limit=50', { token: owner })).body;
  assert.ok(JSON.stringify(audit).includes('self-service signup'), 'the owner creation is on the new tenant\'s audit chain');
  assert.equal((await api.call('GET', '/api/audit/verify', { token: owner })).body.verification.ok, true);
  // The office's time zone is the account default.
  const tz = api.server.store.sql.raw.prepare('SELECT settings FROM tenants WHERE id = ?').get(v.body.tenant.id);
  assert.equal(JSON.parse(tz.settings).defaultTimezone, 'Australia/Sydney');
  // The key signs in like any operator token (browser session).
  const login = await api.call('POST', '/api/auth/login', { body: { token: owner } });
  assert.equal(login.status, 200);
  assert.ok(login.cookies.some(c => /HttpOnly/i.test(c)));

  // Once only.
  assert.equal((await post(api, '/api/signup/verify', { token })).status, 410);
  assert.equal((await post(api, '/api/signup/verify', { token: 'A'.repeat(43) })).status, 410);

  // The platform sees who signed up and what came of it; tenants do not.
  assert.equal((await api.call('GET', '/api/platform/signups', { token: 'owner-token' })).status, 401);
  const list = (await api.call('GET', '/api/platform/signups', { token: PLATFORM })).body.signups;
  assert.equal(list.recent[0].tenantId, v.body.tenant.id);
  assert.ok(list.recent[0].usedAt);
  assert.equal(list.recent[0].sent, 'delivered');
  assert.equal(JSON.stringify(list).includes(token), false);
});

test('signup refuses bad input and does not tell strangers which addresses exist', async t => {
  const { api, mail } = await setup(t);
  assert.equal((await post(api, '/api/signup', form({ email: 'not-an-email' }))).status, 400);
  assert.equal((await post(api, '/api/signup', form({ acceptTerms: false }))).status, 400);
  assert.equal((await post(api, '/api/signup', form({ timeZone: 'Mars/Olympus' }))).status, 400);
  // Hidden field filled (a bot): same answer, no email, no row.
  const bot = await post(api, '/api/signup', form({ website: 'http://spam.example' }));
  assert.equal(bot.status, 200);
  assert.equal(mail.got.length, 0);
  // The same address four times: identical answers, at most three emails.
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push(await post(api, '/api/signup', form()));
  assert.deepEqual(answers.map(a => a.status), [200, 200, 200, 200]);
  assert.equal(new Set(answers.map(a => JSON.stringify(a.body))).size, 1);
  assert.equal(mail.got.length, 3);
  // Five requests from one network per day, then 429.
  assert.equal((await post(api, '/api/signup', form({ email: 'other@harbour.example' }))).status, 200);
  const sixth = await post(api, '/api/signup', form({ email: 'third@harbour.example' }));
  assert.equal(sixth.status, 429);
  assert.equal(sixth.headers.get('retry-after'), '3600');
});

test('signup: daily cap, failed email, expired links, parallel opens, 7-day deletion', async t => {
  const { api, mail } = await setup(t, { statuses: [200, 200, 500], env: { SIGNUP_DAILY_LIMIT: '3' } });
  const sql = api.server.store.sql.raw;
  await post(api, '/api/signup', form({ email: 'a@x.example' }));
  await post(api, '/api/signup', form({ email: 'b@x.example' }));
  // The provider fails: say so (a person would otherwise wait for nothing).
  const failed = await post(api, '/api/signup', form({ email: 'c@x.example' }));
  assert.equal(failed.status, 502);
  assert.equal((await post(api, '/api/signup', form({ email: 'd@x.example' }))).status, 429, 'daily cap of 3');
  assert.equal(mail.got.length, 3);

  // Expired link.
  const tokA = linkToken(mail.got[0]);
  sql.prepare("UPDATE signups SET expires_at = '2000-01-01T00:00:00.000Z' WHERE email = 'a@x.example'").run();
  assert.equal((await post(api, '/api/signup/verify', { token: tokA })).status, 410);

  // Two tabs open the same link at once: exactly one account.
  const tokB = linkToken(mail.got[1]);
  const both = await Promise.all([post(api, '/api/signup/verify', { token: tokB }), post(api, '/api/signup/verify', { token: tokB })]);
  assert.deepEqual(both.map(b => b.status).sort(), [200, 410]);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM tenants WHERE name = 'Harbour Studio'").get().n, 1);

  // Requests (email, name) are deleted after 7 days, used or not.
  sql.prepare("UPDATE signups SET created_at = '2000-01-01T00:00:00.000Z' WHERE email IN ('a@x.example', 'b@x.example')").run();
  await api.server.api.maintainOne('t_default');
  assert.deepEqual(sql.prepare('SELECT email FROM signups ORDER BY email').all().map(r => r.email), ['c@x.example']);
});

test('demo reset: platform only, confirmed, demo tenants only; the audit chain stays and records it', async t => {
  const { api } = await setup(t);
  const seedUsers = require('../data/acl.json').users.length;
  const added = await api.call('POST', '/api/users', { token: 'owner-token', body: { name: 'Prospect Test', groupIds: [] } });
  assert.equal(added.status, 200);
  const users = (await api.call('GET', '/api/users', { token: 'owner-token' })).body.users;
  assert.equal(users.length, seedUsers + 1);
  const headBefore = (await api.call('GET', '/api/audit/verify', { token: 'owner-token' })).body.verification.head.seq;

  const path = '/api/platform/tenants/t_default/demo-reset';
  assert.equal((await api.call('POST', path, { token: 'owner-token', body: { confirm: 't_default' } })).status, 401);
  assert.equal((await api.call('POST', path, { token: PLATFORM, body: {} })).status, 400);
  assert.equal((await api.call('POST', '/api/platform/tenants/t_nope/demo-reset', { token: PLATFORM, body: { confirm: 't_nope' } })).status, 404);
  const r = await api.call('POST', path, { token: PLATFORM, body: { confirm: 't_default' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reset.counts.users, seedUsers);

  const after = (await api.call('GET', '/api/users', { token: 'owner-token' })).body.users;
  assert.equal(after.length, seedUsers);
  assert.ok(!after.some(u => u.name === 'Prospect Test'));
  const v = (await api.call('GET', '/api/audit/verify', { token: 'owner-token' })).body.verification;
  assert.equal(v.ok, true);
  assert.ok(v.head.seq > headBefore, 'history kept, reset appended');
  const last = (await api.call('GET', '/api/audit?limit=1', { token: 'owner-token' })).body;
  assert.match(JSON.stringify(last), /demo\.reset/);
  // The owner still signs in (operators are kept).
  assert.equal((await api.call('GET', '/api/me', { token: 'owner-token' })).status, 200);

  // A tenant with a connected lock account is never reset.
  const now = new Date().toISOString();
  api.server.store.sql.raw.prepare("INSERT INTO vendor_accounts (tenant_id, kind, region, account, account_uid, sealed, token_expires_at, connected_at, updated_at) VALUES ('t_default', 'ttlock', 'eu', 'office@x', '1', 'v2.x', ?, ?, ?)").run(now, now, now);
  const refused = await api.call('POST', path, { token: PLATFORM, body: { confirm: 't_default' } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /only demo tenants/);
});

test('doctor: signup without email is an error; no terms or no billing is a warning', () => {
  const { checkConfig } = require('../doctor-core');
  const f = env => checkConfig({ ADMIN_TOKEN: 'owner-token', SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'), PUBLIC_URL: 'https://doors.example', ...env }, { production: false })
    .filter(x => /^SIGNUP/.test(x.id));
  const lv = r => r.map(x => `${x.level}:${x.id}`).sort();
  assert.deepEqual(f({}), []);
  assert.deepEqual(lv(f({ SIGNUP_ENABLED: '1' })), ['error:SIGNUP_ENABLED']);
  assert.deepEqual(lv(f({ SIGNUP_ENABLED: '1', EMAIL_PROVIDER: 'resend' })), ['ok:SIGNUP_ENABLED', 'warn:SIGNUP_ENABLED', 'warn:SIGNUP_TERMS_URL']);
  assert.deepEqual(lv(f({ SIGNUP_ENABLED: '1', EMAIL_PROVIDER: 'resend', SIGNUP_TERMS_URL: 'https://x.example/terms', BILLING_ENABLED: '1' })), ['ok:SIGNUP_ENABLED']);
});
