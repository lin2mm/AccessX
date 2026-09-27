/**
 * Per-tenant lock-vendor accounts — runtime-agnostic (server + Worker).
 * ====================================================================
 * Each tenant connects ITS OWN TTLock account. Until now TTLock
 * credentials were per deployment, so only the default tenant could have
 * real locks.
 *
 * Security model:
 *  - The TTLock password is used once (password grant) and discarded. We
 *    keep only the OAuth tokens, sealed with SECRETS_KEY and bound to the
 *    tenant (AAD), so a copied row does not decrypt for another tenant.
 *  - The platform's TTLock app (TTLOCK_CLIENT_ID/SECRET) is used unless
 *    a tenant brings its own app; an own client secret is sealed too.
 *  - One TTLock account (uid) → one tenant (unique index), because lock
 *    ids are global at TTLock.
 *  - A token TTLock rejects (password changed, access revoked) flips the
 *    account to `needs_reconnect`: lock calls fail with 503 and a reason,
 *    never silently with an empty fleet.
 */
const { TTLock, ERR } = require('./ttlock');
const { createCloudVendor, VendorUnavailableError } = require('./vendor-ttlock-core');
const { encryptSecret, decryptSecret } = require('./secrets-core');

const PURPOSE = 'vendor.ttlock';
const REGIONS = ['eu', 'cn'];
const DAY = 864e5;

class AccountError extends Error {
  constructor(status, message) { super(message); this.name = 'AccountError'; this.status = status; }
}

/** TTLock login errors → something an owner can act on. */
function loginError(error) {
  switch (error && error.errcode) {
    case ERR.INVALID_ACCOUNT: return new AccountError(400, 'TTLock rejected the username or password');
    case ERR.INVALID_CLIENT: case 10000: return new AccountError(400, 'TTLock rejected the app credentials (client id / client secret)');
    case ERR.APP_NOT_REVIEWED: return new AccountError(400, 'this TTLock app is not approved yet: only its registered test accounts can connect');
    default: return new AccountError(502, `could not reach TTLock: ${String((error && error.message) || error).slice(0, 160)}`);
  }
}

function createVendorAccounts({
  store, secretsKey = '', fetchFn, apiBase = '', platformApp = {}, log = () => {},
  refreshBeforeMs = 7 * DAY, lockCacheMs = 60e3, now = () => Date.now(), refreshGraceMs = 3000,
  onNeedsReconnect = null, // (tenantId, { accountUid, why }) → alert the owners; called once per incident
}) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sql = store.sql;
  const fetch = fetchFn || ((...a) => globalThis.fetch(...a));
  const hasPlatformApp = Boolean(platformApp.clientId && platformApp.clientSecret);
  const cache = new Map(); // tenantId → { updatedAt, vendor }

  const row = tenantId => sql.first('SELECT * FROM vendor_accounts WHERE tenant_id = ?', [tenantId]);
  const seal = (tenantId, obj) => encryptSecret(secretsKey, JSON.stringify(obj), { tenantId, purpose: PURPOSE });
  const unseal = async (tenantId, sealed) => JSON.parse(await decryptSecret(secretsKey, sealed, { tenantId, purpose: PURPOSE }));

  function publicView(r) {
    const base = { platformAppConfigured: hasPlatformApp, secretsKeyConfigured: Boolean(secretsKey), regions: REGIONS };
    if (!r) return { connected: false, ...base };
    return {
      connected: true, ...base,
      kind: r.kind, region: r.region, account: r.account, accountUid: r.account_uid, status: r.status, lastError: r.last_error || null,
      lockCount: r.lock_count, usesPlatformApp: !r.client_id, tokenExpiresAt: r.token_expires_at,
      connectedAt: r.connected_at, connectedBy: r.connected_by, updatedAt: r.updated_at,
    };
  }

  /**
   * `expectSealed`: only if the stored tokens are still the ones that failed —
   * a stale failure must never break an account another instance just refreshed.
   */
  async function markNeedsReconnect(tenantId, why, { expectSealed = null } = {}) {
    const at = new Date(now()).toISOString();
    const r = await row(tenantId);
    if (!r || r.status === 'needs_reconnect') return false;
    if (expectSealed && r.sealed !== expectSealed) return false;
    await sql.batch([{ sql: "UPDATE vendor_accounts SET status = 'needs_reconnect', last_error = ?, updated_at = ? WHERE tenant_id = ? AND sealed = ? AND status <> 'needs_reconnect'",
      params: [String(why).slice(0, 200), at, tenantId, r.sealed] }]);
    const after = await row(tenantId);
    cache.delete(tenantId);
    if (!after || after.status !== 'needs_reconnect' || after.sealed !== r.sealed || after.updated_at !== at) return false; // someone else won
    await store.tenant(tenantId).unit().audit('vendor.needs_reconnect', `ttlock uid=${r.account_uid}: ${String(why).slice(0, 120)}`, 'system').commit();
    if (onNeedsReconnect) {
      try { await onNeedsReconnect(tenantId, { accountUid: r.account_uid, why: String(why).slice(0, 200) }); } catch (error) { log('needs_reconnect hook failed', error.message); }
    }
    return true;
  }

  async function status(tenantId) { return publicView(await row(tenantId)); }

  async function connect(tenantId, input, actor) {
    const b = input || {};
    const region = String(b.region || 'eu');
    if (!REGIONS.includes(region)) throw new AccountError(400, `region must be one of ${REGIONS.join(', ')}`);
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    if (!username || username.length > 100) throw new AccountError(400, 'username is required (the TTLock account that owns the locks)');
    if (typeof b.password !== 'string' || !b.password || b.password.length > 200) throw new AccountError(400, 'password is required');
    const ownApp = Boolean(b.clientId || b.clientSecret);
    if (ownApp && !(typeof b.clientId === 'string' && b.clientId && typeof b.clientSecret === 'string' && b.clientSecret)) {
      throw new AccountError(400, 'clientId and clientSecret must be given together (or neither, to use the platform app)');
    }
    if (!ownApp && !hasPlatformApp) throw new AccountError(400, 'no TTLock app configured on the server (TTLOCK_CLIENT_ID/TTLOCK_CLIENT_SECRET); pass your own clientId and clientSecret');
    if (!secretsKey) throw new AccountError(400, 'SECRETS_KEY is not configured on the server; cannot store vendor tokens');
    const app = ownApp ? { clientId: b.clientId.trim(), clientSecret: b.clientSecret } : platformApp;

    let tokens;
    try {
      tokens = await TTLock.login({ region, apiBase, fetch, clientId: app.clientId, clientSecret: app.clientSecret, username, password: b.password });
    } catch (error) { throw loginError(error); }
    // Prove the token works and see what we are about to control.
    let locks;
    try {
      const tt = new TTLock({ region, apiBase, fetch, clientId: app.clientId, tokenProvider: async () => tokens.accessToken });
      locks = await tt.listAllLocks();
    } catch (error) { throw loginError(error); }
    const uid = tokens.uid || `user:${username.toLowerCase()}`;

    const clash = await sql.first('SELECT tenant_id FROM vendor_accounts WHERE kind = ? AND region = ? AND account_uid = ? AND tenant_id <> ?', ['ttlock', region, uid, tenantId]);
    if (clash) throw new AccountError(409, 'this TTLock account is already connected to another AccessX account');

    const at = new Date(now()).toISOString();
    const sealed = await seal(tenantId, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, clientSecret: ownApp ? app.clientSecret : undefined });
    const prev = await row(tenantId);
    await store.tenant(tenantId).unit().raw(
      `INSERT INTO vendor_accounts (tenant_id, kind, region, account, account_uid, client_id, sealed, token_expires_at, status, last_error, lock_count, connected_by, connected_at, updated_at)
       VALUES (?, 'ttlock', ?, ?, ?, ?, ?, ?, 'connected', NULL, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET kind = excluded.kind, region = excluded.region, account = excluded.account, account_uid = excluded.account_uid,
         client_id = excluded.client_id, sealed = excluded.sealed, token_expires_at = excluded.token_expires_at, status = 'connected', last_error = NULL,
         lock_count = excluded.lock_count, connected_by = excluded.connected_by, connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
      [tenantId, region, username, uid, ownApp ? app.clientId : null, sealed, new Date(tokens.expiresAt).toISOString(), locks.length, actor, at, at],
    )
      // uid, not the username: audit entries carry ids only (GDPR).
      .audit(prev ? 'vendor.reconnect' : 'vendor.connect', `ttlock region=${region} uid=${uid} locks=${locks.length} app=${ownApp ? 'own' : 'platform'}${prev && prev.account_uid !== uid ? ` (was uid=${prev.account_uid})` : ''}`, actor)
      .commit();
    cache.delete(tenantId);
    return { ...publicView(await row(tenantId)), switchedAccount: Boolean(prev && prev.account_uid !== uid) };
  }

  async function disconnect(tenantId, actor) {
    const r = await row(tenantId);
    if (!r) throw new AccountError(404, 'no vendor account connected');
    await store.tenant(tenantId).unit().raw('DELETE FROM vendor_accounts WHERE tenant_id = ?', [tenantId])
      .audit('vendor.disconnect', `ttlock uid=${r.account_uid}`, actor).commit();
    cache.delete(tenantId);
    return publicView(null);
  }

  /** Access tokens for one tenant, refreshed ahead of expiry and shared through the row. */
  function tokenSource(tenantId, clientId) {
    let mem = null; // { sealed, accessToken, refreshToken, clientSecret, expiresAt }
    const load = async () => {
      const r = await row(tenantId);
      if (!r) throw new VendorUnavailableError('the TTLock account was disconnected', { reason: 'disconnected' });
      if (r.status === 'needs_reconnect') throw new VendorUnavailableError('the TTLock account must be reconnected by an owner', { reason: 'needs_reconnect' });
      if (!mem || mem.sealed !== r.sealed) {
        let t;
        try { t = await unseal(tenantId, r.sealed); } catch (error) { throw new VendorUnavailableError(`stored TTLock tokens cannot be decrypted: ${error.message}`, { reason: 'needs_reconnect' }); }
        mem = { sealed: r.sealed, ...t, expiresAt: Date.parse(r.token_expires_at) };
      }
      return r;
    };
    /** Did another instance store newer tokens meanwhile? Waits up to `graceMs`. */
    const adoptedNewer = async (r, graceMs) => {
      for (let waited = 0; ; waited += 200) {
        const latest = await row(tenantId);
        if (latest && latest.sealed !== r.sealed) { await load(); return true; }
        if (waited >= graceMs) return false;
        await sleep(200);
      }
    };
    const refresh = async r => {
      let t;
      try {
        t = await TTLock.refresh({ region: r.region, apiBase, fetch, clientId, clientSecret: mem.clientSecret || platformApp.clientSecret, refreshToken: mem.refreshToken });
      } catch (error) {
        const rejected = error.errcode === ERR.INVALID_REFRESH || error.errcode === ERR.INVALID_GRANT || error.errcode === ERR.INVALID_TOKEN || !mem.refreshToken;
        // Refresh tokens are single-use: if another instance refreshed first, TTLock
        // rejects ours *before* the winner has saved the new pair. Give it a moment.
        if (await adoptedNewer(r, rejected ? refreshGraceMs : 0)) return;
        if (rejected) {
          await markNeedsReconnect(tenantId, `refresh rejected: ${error.message}`, { expectSealed: r.sealed });
          throw new VendorUnavailableError('TTLock refused to refresh the account token — an owner must reconnect the TTLock account', { reason: 'needs_reconnect', cause: error });
        }
        if (mem.expiresAt > now()) { log(`ttlock refresh for ${tenantId} failed, current token still valid`, error.message); return; }
        throw new VendorUnavailableError(`TTLock token expired and refresh failed: ${error.message}`, { reason: 'unavailable', cause: error });
      }
      const sealed = await seal(tenantId, { accessToken: t.accessToken, refreshToken: t.refreshToken || mem.refreshToken, clientSecret: mem.clientSecret });
      const at = new Date(now()).toISOString();
      // Compare-and-swap on the sealed blob: never overwrite a newer token.
      let expect = r.sealed;
      for (let attempt = 0; attempt < 3; attempt++) {
        const u = store.tenant(tenantId).unit()
          .raw("UPDATE vendor_accounts SET sealed = ?, token_expires_at = ?, status = 'connected', last_error = NULL, updated_at = ? WHERE tenant_id = ? AND sealed = ?",
            [sealed, new Date(t.expiresAt).toISOString(), at, tenantId, expect]);
        if (!attempt) u.audit('vendor.token_refreshed', `ttlock uid=${r.account_uid} expires=${new Date(t.expiresAt).toISOString().slice(0, 10)}`, 'system');
        await u.commit();
        const now2 = await row(tenantId);
        if (!now2 || now2.sealed === sealed) break;
        // The row changed under us. If it is the *old* pair re-sealed (SECRETS_KEY
        // rotation), our refresh already consumed that refresh token: write ours
        // over it or the account is dead at the next refresh. Anything else is
        // genuinely newer (another refresh, a reconnect) and wins.
        let stored;
        try { stored = await unseal(tenantId, now2.sealed); } catch { break; }
        if (stored.refreshToken !== mem.refreshToken) break;
        expect = now2.sealed;
      }
      await load();
    };
    // Single-flight inside this instance: parallel requests share one refresh.
    let inflight = null;
    return async ({ force = false } = {}) => {
      if (inflight) { await inflight; return mem.accessToken; }
      const r = await load();
      if (force || mem.expiresAt - now() < refreshBeforeMs) {
        inflight = refresh(r).finally(() => { inflight = null; });
        await inflight;
      }
      return mem.accessToken;
    };
  }

  /** Always a vendor object when an account exists — a broken one reports why on use. */
  async function vendorFor(tenantId) {
    const r = await row(tenantId);
    if (!r) { cache.delete(tenantId); return null; }
    const hit = cache.get(tenantId);
    if (hit && hit.key === `${r.connected_at}|${r.status}`) return hit.vendor;
    let vendor;
    if (r.status === 'needs_reconnect') {
      vendor = brokenVendor(new VendorUnavailableError('the TTLock account must be reconnected by an owner', { reason: 'needs_reconnect' }), r);
    } else {
      const tt = new TTLock({ region: r.region, apiBase, fetch, clientId: r.client_id || platformApp.clientId, tokenProvider: tokenSource(tenantId, r.client_id || platformApp.clientId) });
      vendor = createCloudVendor(tt, {
        label: `TTLock account ${r.account}`, region: r.region, cacheMs: lockCacheMs, now,
        onAuthFailure: error => markNeedsReconnect(tenantId, error.message),
      });
    }
    cache.set(tenantId, { key: `${r.connected_at}|${r.status}`, vendor });
    return vendor;
  }

  return { status, connect, disconnect, vendorFor, markNeedsReconnect, AccountError };
}

function brokenVendor(error, r) {
  const fail = async () => { throw error; };
  return {
    kind: 'ttlock', demo: false, broken: true,
    status: () => ({ mode: `TTLock account ${r.account} — reconnect required`, region: r.region, reason: error.reason }),
    listLocks: fail, unlock: fail, createPasscode: fail, deletePasscode: fail, records: fail,
    async info() { return { active: 'ttlock', available: ['ttlock', 'demo'], capabilities: {}, health: { vendor: 'ttlock', ok: false, mode: 'reconnect required', note: error.message } }; },
    mirror: null,
  };
}

module.exports = { createVendorAccounts, AccountError, PURPOSE };
