const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { boot } = require('../support/boot');
const { demoFixture } = require('../support/fake-ttlock');

const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

async function setup(t, extraEnv = {}) {
  const cloud = demoFixture();
  const base = await cloud.listen(0);
  const api = await boot({
    ADMIN_TOKEN: 'owner-token', PLATFORM_TOKEN: 'platform-token', SECRETS_KEY,
    TTLOCK_API_BASE: base, TTLOCK_CLIENT_ID: 'platform-app', TTLOCK_CLIENT_SECRET: 'platform-secret',
    RECONCILE_INTERVAL_MIN: '0', ...extraEnv,
  });
  t.after(async () => { await api.close(); await cloud.close(); });
  return { api, cloud, owner: { token: 'owner-token' } };
}

const RIVERSIDE = { region: 'eu', username: 'riverside-admin', password: 'river-pass-1' };

test('connect a tenant\'s own TTLock account: password never stored, locks come from the account', async t => {
  const { api, cloud, owner } = await setup(t);

  assert.equal((await api.call('GET', '/api/vendor-account', owner)).body.account.connected, false);
  const wrong = await api.call('PUT', '/api/vendor-account', { ...owner, body: { ...RIVERSIDE, password: 'nope' } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /username or password/);

  const ok = await api.call('PUT', '/api/vendor-account', { ...owner, body: RIVERSIDE });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.account.connected, true);
  assert.equal(ok.body.account.lockCount, 4);
  assert.equal(ok.body.account.usesPlatformApp, true);
  // OAuth uses snake_case client_id and an MD5 password (the old client sent clientId → login never worked).
  const login = cloud.callsTo('/oauth2/token').at(-1).params;
  assert.equal(login.client_id, 'platform-app');
  assert.equal(login.password, require('node:crypto').createHash('md5').update('river-pass-1').digest('hex'));

  // Nothing secret leaves the API or lands in the database in clear text.
  const shown = JSON.stringify(ok.body);
  const issued = [...cloud.state.tokens.keys()];
  for (const secret of ['river-pass-1', ...issued]) assert.equal(shown.includes(secret), false, `response leaks ${secret.slice(0, 6)}`);
  const dbFiles = fs.readdirSync(api.dataDir).filter(f => f.startsWith('accessx.sqlite')).map(f => fs.readFileSync(path.join(api.dataDir, f)).toString('latin1')).join('');
  for (const secret of ['river-pass-1', login.password, ...issued]) assert.equal(dbFiles.includes(secret), false, 'secret stored in clear text');

  const doors = await api.call('GET', '/api/doors', owner);
  assert.equal(doors.status, 200);
  assert.deepEqual(doors.body.doors.map(d => d.lockId).sort(), [9001, 9002, 9003, 9004]);
  assert.equal(doors.body.demo, false);
  assert.match((await api.call('GET', '/api/status', owner)).body.mode, /LIVE \(TTLock account riverside-admin\)/);

  const log = await api.call('GET', '/api/audit?action=vendor.connect', owner);
  assert.match(log.body.log[0].detail, /uid=71001 locks=4 app=platform/);
  assert.equal(log.body.log[0].detail.includes('riverside-admin'), false, 'audit carries the uid, not the username');
});

test('codes go to the real lock and come off with deleteType=2; offline lock → on-site removal', async t => {
  const { api, cloud, owner } = await setup(t);
  await api.call('PUT', '/api/vendor-account', { ...owner, body: RIVERSIDE });

  const dev = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u2' } });
  assert.equal(dev.status, 200, JSON.stringify(dev.body));
  const devRef = dev.body.credential.vendorRef;
  assert.equal(cloud.onDevice(9002, devRef), true);

  const sarah = await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9004, userId: 'u1', acknowledgeScheduleGap: true } });
  assert.equal(sarah.status, 200, JSON.stringify(sarah.body));

  // Dev leaves: suspension revokes at once, through the gateway.
  const s1 = await api.call('POST', '/api/users/u2/suspend', owner);
  assert.equal(s1.body.reconcile.revoked, 1);
  assert.equal(cloud.onDevice(9002, devRef), false, 'code must be gone from the DEVICE, not just the cloud');
  assert.equal(cloud.callsTo('/v3/keyboardPwd/delete').at(-1).params.deleteType, '2');

  // Sarah leaves: 9004 has no gateway → the code stays on the lock until someone visits.
  const s2 = await api.call('POST', '/api/users/u1/suspend', owner);
  assert.equal(s2.body.reconcile.pendingRemoval, 1);
  const creds = (await api.call('GET', '/api/credentials', owner)).body.credentials;
  assert.equal(creds.find(c => c.userId === 'u1').status, 'pending_removal');
});

test('one TTLock account → one tenant; tenants only reach their own locks', async t => {
  const { api, owner } = await setup(t);
  await api.call('PUT', '/api/vendor-account', { ...owner, body: RIVERSIDE });
  const created = await api.call('POST', '/api/tenants', { token: 'platform-token', body: { name: 'Northgate Gym' } });
  const other = { token: created.body.owner.token };

  const steal = await api.call('PUT', '/api/vendor-account', { ...other, body: RIVERSIDE });
  assert.equal(steal.status, 409);
  assert.match(steal.body.error, /already connected to another/);

  const own = await api.call('PUT', '/api/vendor-account', { ...other, body: { region: 'eu', username: 'northgate-admin', password: 'north-pass-1' } });
  assert.equal(own.status, 200);
  assert.deepEqual((await api.call('GET', '/api/doors', other)).body.doors.map(d => d.lockId).sort(), [9101, 9102]);
  // Riverside's lock is not in Northgate's fleet → unknown, never opened.
  const cross = await api.call('POST', '/api/doors/9002/unlock', { ...other, body: { reason: 'cross-tenant attempt' } });
  assert.equal(cross.status, 404);
  // The other tenant's owner cannot see or remove Riverside's account.
  assert.equal((await api.call('GET', '/api/vendor-account', other)).body.account.account, 'northgate-admin');
});

test('token lifecycle: expired → refreshed once and shared; revoked at TTLock → 503 needs_reconnect, then reconnect', async t => {
  const { api, cloud, owner } = await setup(t);
  await api.call('PUT', '/api/vendor-account', { ...owner, body: RIVERSIDE });
  const sealedBefore = api.server.store.sql.first ? await api.server.store.sql.first('SELECT sealed FROM vendor_accounts') : null;

  cloud.expireTokens();
  const unlock = await api.call('POST', '/api/doors/9001/unlock', { ...owner, body: { reason: 'delivery at the front' } });
  assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
  const refreshes = cloud.callsTo('/oauth2/token').filter(c => c.params.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  const sealedAfter = await api.server.store.sql.first('SELECT sealed, status FROM vendor_accounts');
  assert.notEqual(sealedAfter.sealed, sealedBefore.sealed, 'refreshed tokens are persisted for other instances');
  assert.equal((await api.call('GET', '/api/audit?action=vendor.token_refreshed', owner)).body.log.length, 1);

  // IT changes the TTLock password: every token and refresh token dies.
  cloud.revokeAccount('riverside-admin');
  const denied = await api.call('POST', '/api/doors/9001/unlock', { ...owner, body: { reason: 'delivery at the front' } });
  assert.equal(denied.status, 503);
  assert.equal(denied.body.reason, 'needs_reconnect');
  const status = (await api.call('GET', '/api/vendor-account', owner)).body.account;
  assert.equal(status.status, 'needs_reconnect');
  assert.equal((await api.call('GET', '/api/doors', owner)).status, 503, 'no silent empty fleet');
  assert.equal((await api.call('GET', '/api/users', owner)).status, 200, 'the rest of the app keeps working');
  assert.equal((await api.call('GET', '/api/audit?action=vendor.needs_reconnect', owner)).body.log.length, 1);

  cloud.setPassword('riverside-admin', 'river-pass-2');
  const again = await api.call('PUT', '/api/vendor-account', { ...owner, body: { ...RIVERSIDE, password: 'river-pass-2' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.account.status, 'connected');
  assert.equal((await api.call('GET', '/api/doors', owner)).status, 200);
});

test('own TTLock app, disconnect falls back to the demo fleet, owner-only, needs SECRETS_KEY', async t => {
  const { api, cloud, owner } = await setup(t, {
    OPERATORS: JSON.stringify([{ id: 'op_mgr', name: 'Manager', role: 'r_manager', tokenSha256: require('../audit-core').sha256Hex('mgr-token') }]),
  });
  assert.equal((await api.call('PUT', '/api/vendor-account', { token: 'mgr-token', body: RIVERSIDE })).status, 403);
  assert.equal((await api.call('GET', '/api/vendor-account', { token: 'mgr-token' })).status, 403);
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...owner, body: { ...RIVERSIDE, clientId: 'own-app' } })).status, 400);
  const own = await api.call('PUT', '/api/vendor-account', { ...owner, body: { ...RIVERSIDE, clientId: 'own-app', clientSecret: 'own-secret' } });
  assert.equal(own.status, 200);
  assert.equal(own.body.account.usesPlatformApp, false);
  assert.equal(cloud.callsTo('/v3/lock/list').at(-1).params.clientId, 'own-app');

  const off = await api.call('DELETE', '/api/vendor-account', owner);
  assert.equal(off.status, 200);
  const doors = await api.call('GET', '/api/doors', owner);
  assert.equal(doors.body.demo, true, 'default tenant falls back to its demo fleet');

  const noKey = await setup(t, { SECRETS_KEY: '' });
  const r = await noKey.api.call('PUT', '/api/vendor-account', { token: 'owner-token', body: RIVERSIDE });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /SECRETS_KEY/);
});
