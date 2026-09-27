const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot } = require('../support/boot');
const { demoFixture } = require('../support/fake-ttlock');
const { encryptSecret, decryptSecret, sealedKeyId, primaryKeyId } = require('../secrets-core');
const { createSecretsRotation } = require('../secrets-rotation');

const OLD = Buffer.alloc(32, 7).toString('base64');
const NEW = Buffer.alloc(32, 9).toString('base64');
const RING = `${NEW},${OLD}`;
const RIVERSIDE = { region: 'eu', username: 'riverside-admin', password: 'river-pass-1' };
const OWNER = { token: 'owner-token' };
const PLATFORM = { token: 'platform-token' };

/** What secrets-core wrote before key ids existed: v1.<iv>.<ct>. */
async function legacyV1(base64Key, plaintext, { tenantId, purpose }) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(base64Key, 'base64'), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${tenantId}|${purpose}`) }, key, new TextEncoder().encode(plaintext));
  return `v1.${Buffer.from(iv).toString('base64')}.${Buffer.from(ct).toString('base64')}`;
}

test('keyring: first key seals, every key opens, legacy v1 still opens, tenant/purpose stay bound', async () => {
  const ctx = { tenantId: 't_a', purpose: 'p' };
  const sealed = await encryptSecret(OLD, 'hello', ctx);
  assert.equal(sealedKeyId(sealed), await primaryKeyId(OLD));
  assert.equal(await decryptSecret(RING, sealed, ctx), 'hello', 'old key still in the ring');
  await assert.rejects(decryptSecret(NEW, sealed, ctx), /not in SECRETS_KEY/, 'names the missing key instead of a bare crypto error');
  const v1 = await legacyV1(OLD, 'legacy', ctx);
  assert.equal(await decryptSecret(RING, v1, ctx), 'legacy');
  await assert.rejects(decryptSecret(NEW, v1, ctx), /any SECRETS_KEY/);
  await assert.rejects(decryptSecret(RING, sealed, { ...ctx, tenantId: 't_b' }));
  await assert.rejects(decryptSecret(RING, sealed, { ...ctx, purpose: 'q' }));
  assert.equal(sealedKeyId(await encryptSecret(RING, 'x', ctx)), await primaryKeyId(NEW), 'the first key of the ring seals');
  await assert.rejects(encryptSecret(`${NEW},short`, 'x', ctx), /32 bytes/);
});

test('SECRETS_KEY rotation: add the new key, re-seal every secret, drop the old key — nothing breaks', async t => {
  const cloud = demoFixture();
  const base = await cloud.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessx-rotate-'));
  let api = null;
  t.after(async () => { if (api) await api.close(); await cloud.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = key => ({
    DATA_DIR: dir, ADMIN_TOKEN: 'owner-token', PLATFORM_TOKEN: 'platform-token', SECRETS_KEY: key, ALLOW_HTTP_WEBHOOKS: '1',
    TTLOCK_API_BASE: base, TTLOCK_CLIENT_ID: 'platform-app', TTLOCK_CLIENT_SECRET: 'platform-secret', RECONCILE_INTERVAL_MIN: '0',
  });

  // 1. Life on the old key: TTLock tokens, an alert webhook, an SSO secret, a waiting approval code (legacy v1).
  api = await boot(env(OLD));
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...OWNER, body: RIVERSIDE })).status, 200);
  assert.equal((await api.call('PUT', '/api/alerts', { ...OWNER, body: { webhookUrl: 'http://127.0.0.1:9/hooks/secret-path', format: 'json' } })).status, 200);
  const sql = api.server.store.sql;
  const ssoSealed = await encryptSecret(OLD, 'idp-client-secret', { tenantId: 't_default', purpose: 'sso.clientSecret' });
  await sql.batch([{ sql: "UPDATE tenants SET settings = json_set(settings, '$.sso', json(?)) WHERE id = 't_default'", params: [JSON.stringify({ issuer: 'https://idp.example', clientId: 'ax', clientSecretEnc: ssoSealed })] }]);
  const code = JSON.stringify({ code: '731904', lockId: 9004 });
  await sql.batch([{
    sql: "INSERT INTO approvals (tenant_id, id, summary, payload, locks, requested_by, requested_at, expires_at, status, decided_by, decided_at, sealed_code) VALUES ('t_default', 'ap_1', 's', '{}', '[9004]', 'op_a', ?, ?, 'approved', 'op_b', ?, ?)",
    params: [new Date().toISOString(), new Date(Date.now() + 864e5).toISOString(), new Date().toISOString(), await legacyV1(OLD, code, { tenantId: 't_default', purpose: 'approval-code:ap_1' })],
  }]);
  await api.close(); api = null;

  // 2. Deploy with "new,old": everything still opens; status shows what is left on the old key.
  api = await boot(env(RING));
  assert.equal((await api.call('GET', '/api/platform/secrets', OWNER)).status, 401, 'deployment-wide: not a tenant owner\'s business');
  const before = (await api.call('GET', '/api/platform/secrets', PLATFORM)).body;
  assert.equal(before.primaryKeyId, await primaryKeyId(NEW));
  assert.equal(before.total, 4);
  assert.equal(before.onOldKeys, 4);
  assert.equal(before.safeToDropOldKeys, false);
  assert.deepEqual(before.byKey, { [await primaryKeyId(OLD)]: 3, v1: 1 });
  assert.deepEqual(Object.keys(before.byKind).sort(), ['alerts', 'approval', 'sso', 'vendor']);
  const doors = await api.call('GET', '/api/doors', OWNER);
  assert.equal(doors.status, 200);
  assert.equal(doors.body.demo, false, 'TTLock tokens sealed with the old key still open');

  // 3. Re-seal: all four move to the new key, one audit entry per tenant, idempotent.
  assert.equal((await api.call('POST', '/api/platform/secrets/reseal', OWNER)).status, 401);
  const r1 = (await api.call('POST', '/api/platform/secrets/reseal', PLATFORM)).body;
  assert.equal(r1.resealed, 4, JSON.stringify(r1));
  assert.deepEqual(r1.failed, []);
  assert.equal(r1.status.onOldKeys, 0);
  assert.equal(r1.status.safeToDropOldKeys, true);
  const log = (await api.call('GET', '/api/audit?action=secrets.resealed', OWNER)).body.log;
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /vendor=1/);
  assert.match(log[0].detail, /approval=1/);
  assert.equal(log[0].detail.includes('secret-path'), false, 'audit never carries secrets');
  const r2 = (await api.call('POST', '/api/platform/secrets/reseal', PLATFORM)).body;
  assert.equal(r2.resealed, 0);
  assert.equal(r2.alreadyCurrent, 4);
  await api.close(); api = null;

  // 4. Old key gone: every secret still opens with the new key alone.
  api = await boot(env(NEW));
  const d2 = await api.call('GET', '/api/doors', OWNER);
  assert.equal(d2.status, 200);
  assert.equal(d2.body.demo, false);
  assert.equal((await api.call('GET', '/api/vendor-account', OWNER)).body.account.status, 'connected');
  assert.equal((await api.call('GET', '/api/alerts', OWNER)).body.alerts.host, '127.0.0.1:9');
  const row = await api.server.store.sql.first("SELECT sealed_code, json_extract(settings, '$.sso.clientSecretEnc') AS sso FROM approvals, tenants WHERE approvals.id = 'ap_1' AND tenants.id = 't_default'");
  assert.equal(await decryptSecret(NEW, row.sealed_code, { tenantId: 't_default', purpose: 'approval-code:ap_1' }), code);
  assert.equal(await decryptSecret(NEW, row.sso, { tenantId: 't_default', purpose: 'sso.clientSecret' }), 'idp-client-secret');
  assert.equal((await api.call('GET', '/api/platform/secrets', PLATFORM)).body.unknownKey, 0);
});

test('a TTLock token refresh that lands right after a re-seal keeps the new tokens (the old refresh token is spent)', async t => {
  const cloud = demoFixture();
  const base = await cloud.listen(0);
  const api = await boot({
    ADMIN_TOKEN: 'owner-token', SECRETS_KEY: OLD, TTLOCK_API_BASE: base, TTLOCK_CLIENT_ID: 'platform-app', TTLOCK_CLIENT_SECRET: 'platform-secret', RECONCILE_INTERVAL_MIN: '0',
  });
  t.after(async () => { await api.close(); await cloud.close(); });
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...OWNER, body: RIVERSIDE })).status, 200);
  const store = api.server.store;
  const { createVendorAccounts } = require('../vendor-accounts');
  const make = key => createVendorAccounts({ store, secretsKey: key, apiBase: base, platformApp: { clientId: 'platform-app', clientSecret: 'platform-secret' }, lockCacheMs: 0 });
  const rotation = createSecretsRotation({ store, secretsKey: RING });

  // The instance has read the row and refreshed at TTLock; the re-seal commits just before its write.
  const batch = store.sql.batch.bind(store.sql);
  let injected = 0;
  store.sql.batch = async stmts => {
    if (!injected && stmts.some(s => /SET sealed = \?, token_expires_at/.test(s.sql))) { injected++; await rotation.reseal(); }
    return batch(stmts);
  };
  t.after(() => { store.sql.batch = batch; });
  cloud.expireTokens();
  assert.ok((await (await make(RING).vendorFor('t_default')).listLocks()).length);
  assert.equal(injected, 1, 'the re-seal really ran inside the refresh');
  store.sql.batch = batch;

  const r = await store.sql.first('SELECT sealed, status FROM vendor_accounts');
  const stored = JSON.parse(await decryptSecret(RING, r.sealed, { tenantId: 't_default', purpose: 'vendor.ttlock' }));
  assert.equal(cloud.state.refresh.has(stored.refreshToken), true, 'the stored refresh token is the live one, not the spent one');
  assert.equal(sealedKeyId(r.sealed), await primaryKeyId(NEW));
  assert.equal(r.status, 'connected');

  // Next refresh, new key only: TTLock accepts it.
  cloud.expireTokens();
  assert.ok((await (await make(NEW).vendorFor('t_default')).listLocks()).length);
  assert.equal((await store.sql.first('SELECT status FROM vendor_accounts')).status, 'connected');
});

test('a re-seal never overwrites tokens refreshed after it read them (compare-and-set)', async t => {
  const cloud = demoFixture();
  const base = await cloud.listen(0);
  const api = await boot({
    ADMIN_TOKEN: 'owner-token', SECRETS_KEY: OLD, TTLOCK_API_BASE: base, TTLOCK_CLIENT_ID: 'platform-app', TTLOCK_CLIENT_SECRET: 'platform-secret', RECONCILE_INTERVAL_MIN: '0',
  });
  t.after(async () => { await api.close(); await cloud.close(); });
  assert.equal((await api.call('PUT', '/api/vendor-account', { ...OWNER, body: RIVERSIDE })).status, 200);
  const store = api.server.store;
  const { createVendorAccounts } = require('../vendor-accounts');
  const oldInstance = createVendorAccounts({ store, secretsKey: OLD, apiBase: base, platformApp: { clientId: 'platform-app', clientSecret: 'platform-secret' }, lockCacheMs: 0 });
  const batch = store.sql.batch.bind(store.sql);
  let injected = 0;
  store.sql.batch = async stmts => {
    if (!injected && stmts.some(s => /^UPDATE vendor_accounts SET sealed = \? WHERE/.test(s.sql))) {
      injected++; // an instance still on the old deploy refreshes between the re-seal's read and write
      store.sql.batch = batch;
      cloud.expireTokens();
      await (await oldInstance.vendorFor('t_default')).listLocks();
    }
    return batch(stmts);
  };
  t.after(() => { store.sql.batch = batch; });
  const out = await createSecretsRotation({ store, secretsKey: RING }).reseal();
  assert.equal(injected, 1);
  assert.equal(out.changedMeanwhile, 1);
  assert.equal(out.resealed, 0);
  const r = await store.sql.first('SELECT sealed FROM vendor_accounts');
  const stored = JSON.parse(await decryptSecret(RING, r.sealed, { tenantId: 't_default', purpose: 'vendor.ttlock' }));
  assert.equal(cloud.state.refresh.has(stored.refreshToken), true, 'the refreshed pair survived');
  assert.equal((await createSecretsRotation({ store, secretsKey: RING }).reseal()).resealed, 1, 'the next run picks it up');
});
