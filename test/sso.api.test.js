const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/boot');

const OWNER = 'owner-secret';
const KEY = Buffer.alloc(32, 9).toString('base64');

/** Browser-like walk: start → mock IdP (pick user) → callback with the flow cookie. */
async function ssoLogin(ctx, sub, { query = '', flowCookie: overrideCookie, replay } = {}) {
  const start = await ctx.call('GET', `/api/auth/sso/start${query}`);
  assert.equal(start.status, 302);
  const loc = start.headers.get('location');
  if (loc.startsWith('/?sso_error')) return { error: new URLSearchParams(loc.slice(2)).get('sso_error') };
  const flowCookie = overrideCookie !== undefined ? overrideCookie : start.cookies.find(c => /^ax_sso=/.test(c)).split(';')[0];
  const authUrl = new URL(loc, ctx.base);
  authUrl.searchParams.set('user', sub);
  const idp = await fetch(authUrl, { redirect: 'manual' });
  const cb = new URL(idp.headers.get('location'));
  const res = await ctx.call('GET', cb.pathname + cb.search, { headers: { cookie: flowCookie } });
  if (replay) await replay(cb, flowCookie);
  const where = res.headers.get('location');
  const session = res.cookies.find(c => /^ax_session=[^;]/.test(c));
  return { status: res.status, where, error: where && where.includes('sso_error') ? new URLSearchParams(where.slice(2)).get('sso_error') : null, cookie: session && session.split(';')[0], cb, flowCookie };
}

async function setup() {
  const ctx = await boot({ ADMIN_TOKEN: OWNER, MOCK_IDP: '1', SECRETS_KEY: KEY });
  const put = await ctx.call('PUT', '/api/sso', { token: OWNER, body: { issuer: `${ctx.base}/mock-idp`, clientId: 'accessx-test', clientSecret: 's3cret-value', domains: ['riverside.example'] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  return ctx;
}

const invite = (ctx, email = 'alice@riverside.example') => ctx.call('POST', '/api/operators', {
  token: OWNER, body: { name: 'Alice', role: 'r_manager', siteIds: ['site_river'], email, auth: 'sso' },
});

test('SSO config: owner only, https enforced unless mock, secret sealed and never returned', async () => {
  const ctx = await boot({ ADMIN_TOKEN: OWNER, MOCK_IDP: '1', SECRETS_KEY: KEY, OPERATORS: JSON.stringify([{ name: 'M', role: 'r_manager', tokenSha256: require('node:crypto').createHash('sha256').update('mgr-token').digest('hex') }]) });
  try {
    assert.equal((await ctx.call('PUT', '/api/sso', { token: 'mgr-token', body: {} })).status, 403);
    assert.equal((await ctx.call('PUT', '/api/sso', { token: OWNER, body: { issuer: 'not a url', clientId: 'x' } })).status, 400);
    const unreachable = await ctx.call('PUT', '/api/sso', { token: OWNER, body: { issuer: `${ctx.base}/nope`, clientId: 'x' } });
    assert.equal(unreachable.status, 400);
    assert.match(unreachable.body.error, /discovery failed/);
    const ok = await ctx.call('PUT', '/api/sso', { token: OWNER, body: { issuer: `${ctx.base}/mock-idp/`, clientId: 'accessx-test', clientSecret: 'super-secret-value', domains: ['Riverside.Example'] } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.sso.issuer, `${ctx.base}/mock-idp`);
    assert.deepEqual(ok.body.sso.domains, ['riverside.example']);
    assert.equal(ok.body.sso.hasClientSecret, true);
    assert.ok(!JSON.stringify(ok.body).includes('super-secret-value'));
    const stored = await ctx.server.store.tenantSettings('t_default');
    assert.match(stored.sso.clientSecretEnc, /^v1\./);
    assert.ok(!JSON.stringify(stored).includes('super-secret-value'), 'secret must be encrypted at rest');
    // Re-saving without a secret keeps the sealed one.
    const again = await ctx.call('PUT', '/api/sso', { token: OWNER, body: { issuer: `${ctx.base}/mock-idp`, clientId: 'accessx-test', domains: ['riverside.example'] } });
    assert.equal(again.body.sso.hasClientSecret, true);
    const session = await ctx.call('GET', '/api/auth/session');
    assert.equal(session.body.sso, true);
  } finally { await ctx.close(); }
});

test('SSO: invited operator signs in; uninvited and unverified-email logins are refused and audited', async () => {
  const ctx = await setup();
  try {
    assert.equal((await ssoLogin(ctx, 'mock|bob')).error, 'not_invited');
    const inv = await invite(ctx);
    assert.equal(inv.status, 200);
    assert.equal(inv.body.token, undefined, 'SSO operators get no token');
    // nOAuth: Mallory's IdP account *claims* alice's address but it is unverified.
    assert.equal((await ssoLogin(ctx, 'mock|mallory')).error, 'unverified_email');

    const alice = await ssoLogin(ctx, 'mock|alice', { query: '?email=alice@riverside.example' });
    assert.equal(alice.status, 302);
    assert.equal(alice.where, '/');
    assert.ok(alice.cookie);
    const me = await ctx.call('GET', '/api/auth/session', { headers: { cookie: alice.cookie } });
    assert.equal(me.body.authenticated, true);
    assert.equal(me.body.via, 'sso');
    assert.equal(me.body.operator.role, 'r_manager');
    assert.deepEqual(me.body.operator.siteIds, ['site_river']);

    // Second login uses the (issuer, subject) link, not the email.
    assert.ok((await ssoLogin(ctx, 'mock|alice')).cookie);
    // Even now Mallory cannot ride on the linked account.
    assert.equal((await ssoLogin(ctx, 'mock|mallory')).error, 'unverified_email');

    const ops = (await ctx.call('GET', '/api/operators', { token: OWNER })).body.operators;
    const a = ops.find(o => o.email === 'alice@riverside.example');
    assert.equal(a.ssoLinked, true);
    assert.ok(a.lastLoginAt);

    const log = (await ctx.call('GET', '/api/audit?limit=50', { token: OWNER })).body.log;
    const actions = log.map(e => `${e.action} ${e.detail}`);
    assert.ok(actions.some(x => x.startsWith('operator.sso_linked')));
    assert.ok(actions.some(x => x === 'operator.login via sso'));
    assert.ok(actions.some(x => /login_denied via sso: unverified email \(domain riverside\.example\)/.test(x)));
    assert.ok(actions.some(x => /login_denied via sso: no invitation/.test(x)));
    assert.ok(!actions.some(x => x.includes('bob@')), 'denied attempts log the domain, not the address');
  } finally { await ctx.close(); }
});

test('SSO: flow is single-use and bound to the starting browser (login CSRF)', async () => {
  const ctx = await setup();
  try {
    await invite(ctx);
    // Attacker completes the IdP step but the victim's browser lacks the flow cookie.
    assert.equal((await ssoLogin(ctx, 'mock|alice', { flowCookie: '' })).error, 'expired');
    // Replay of a used callback URL.
    let replayed;
    await ssoLogin(ctx, 'mock|alice', {
      replay: async (cb, cookie) => { replayed = await ctx.call('GET', cb.pathname + cb.search, { headers: { cookie } }); },
    });
    assert.match(replayed.headers.get('location'), /sso_error=expired/);
    // Forged state.
    const forged = await ctx.call('GET', '/api/auth/sso/callback?code=x&state=forged', { headers: { cookie: 'ax_sso=forged' } });
    assert.match(forged.headers.get('location'), /sso_error=expired/);
  } finally { await ctx.close(); }
});

test('SSO: revoking the operator or removing SSO ends sessions and blocks new logins', async () => {
  const ctx = await setup();
  try {
    const inv = await invite(ctx);
    const first = await ssoLogin(ctx, 'mock|alice');
    assert.equal((await ctx.call('GET', '/api/me', { headers: { cookie: first.cookie } })).status, 200);
    await ctx.call('DELETE', `/api/operators/${inv.body.operator.id}`, { token: OWNER });
    assert.equal((await ctx.call('GET', '/api/me', { headers: { cookie: first.cookie } })).status, 401);
    assert.equal((await ssoLogin(ctx, 'mock|alice')).error, 'not_invited');

    assert.equal((await invite(ctx, 'alice@riverside.example')).status, 200, 'rehire: same email can be invited again');
    // Previous row is revoked, so the new invitation links afresh.
    const second = await ssoLogin(ctx, 'mock|alice');
    assert.ok(second.cookie);
    assert.equal((await ctx.call('DELETE', '/api/sso', { token: OWNER })).status, 200);
    assert.equal((await ctx.call('GET', '/api/me', { headers: { cookie: second.cookie } })).status, 401);
    assert.equal((await ssoLogin(ctx, 'mock|alice')).error, 'not_configured');
  } finally { await ctx.close(); }
});

test('SSO: email-domain routing picks the tenant; domains cannot be claimed twice', async () => {
  const ctx = await boot({ ADMIN_TOKEN: OWNER, MOCK_IDP: '1', SECRETS_KEY: KEY, PLATFORM_TOKEN: 'plat' });
  try {
    const t2 = await ctx.call('POST', '/api/tenants', { token: 'plat', body: { name: 'Second Co' } });
    const owner2 = t2.body.owner.token;
    const put2 = await ctx.call('PUT', '/api/sso', { token: owner2, body: { issuer: `${ctx.base}/mock-idp`, clientId: 'second', domains: ['riverside.example'] } });
    assert.equal(put2.status, 200);
    const clash = await ctx.call('PUT', '/api/sso', { token: OWNER, body: { issuer: `${ctx.base}/mock-idp`, clientId: 'accessx-test', domains: ['riverside.example'] } });
    assert.equal(clash.status, 409);
    await ctx.call('POST', '/api/operators', { token: owner2, body: { name: 'Alice2', role: 'r_view', email: 'alice@riverside.example', auth: 'sso' } });
    const start = await ctx.call('GET', '/api/auth/sso/start?email=alice@riverside.example');
    assert.match(start.headers.get('location'), /client_id=second/);
    const res = await ssoLogin(ctx, 'mock|alice', { query: '?email=alice@riverside.example' });
    const me = await ctx.call('GET', '/api/auth/session', { headers: { cookie: res.cookie } });
    assert.equal(me.body.tenant.id, t2.body.tenant.id);
  } finally { await ctx.close(); }
});
