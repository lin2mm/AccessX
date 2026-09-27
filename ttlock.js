/**
 * TTLock Cloud API v3 client — runs in Node and in Cloudflare Workers
 * (no node:crypto, no process.env unless it exists).
 * Docs: https://euopen.ttlock.com/document/doc
 *
 * Two ways to authenticate:
 *  - legacy single-tenant server: TTLOCK_CLIENT_ID / TTLOCK_CLIENT_SECRET /
 *    TTLOCK_USER / TTLOCK_PASS env vars (password grant, token kept in memory);
 *  - per-tenant accounts (vendor-accounts.js): `tokenProvider` hands out an
 *    access token that was obtained once and is stored encrypted — the
 *    customer's TTLock password is never stored.
 */
const { md5Hex } = require('./md5');

const ENV = typeof process !== 'undefined' && process.env ? process.env : {};
const REGION = {
  eu: { api: 'https://euapi.ttlock.com' },
  cn: { api: 'https://api.sciener.com' },
};

/** TTLock answers HTTP 200 with {errcode, errmsg}; keep the code for callers. */
class TTLockError extends Error {
  constructor(path, errcode, errmsg) {
    super(`TTLock ${path} ${errcode}: ${errmsg}`);
    this.errcode = Number(errcode);
    this.path = path;
  }
}
// https://euopen.ttlock.com/doc/api/error
const ERR = {
  NO_GATEWAY: -2012, RATE_LIMIT: 30006, CLOCK_SKEW: 80000,
  INVALID_CLIENT: 10001, INVALID_TOKEN: 10003, INVALID_GRANT: 10004,
  APP_NOT_REVIEWED: 10006, INVALID_ACCOUNT: 10007, INVALID_REFRESH: 10011,
};
const TOKEN_ERRORS = new Set([ERR.INVALID_TOKEN, ERR.INVALID_GRANT]);

function apiBase(region, override) {
  if (override) return String(override).replace(/\/+$/, '');
  const r = REGION[region || 'eu'];
  if (!r) throw new Error(`unknown TTLock region ${region}`);
  return r.api;
}

/**
 * POST /oauth2/token. NOTE the snake_case client_id / client_secret: the
 * OAuth endpoint differs from the v3 API (which takes clientId).
 */
async function oauthToken({ base, fetch, clientId, clientSecret, form }) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...form });
  const r = await fetch(`${base}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  let j;
  try { j = await r.json(); } catch { throw new TTLockError('/oauth2/token', 90000, `HTTP ${r.status}, not JSON`); }
  if (j.errcode || !j.access_token) throw new TTLockError('/oauth2/token', j.errcode || 1, j.errmsg || j.error_description || j.error || 'no access_token');
  return {
    accessToken: j.access_token, refreshToken: j.refresh_token || null, uid: j.uid === undefined ? null : String(j.uid),
    expiresAt: Date.now() + (Number(j.expires_in) || 7776000) * 1000, scope: j.scope || null,
  };
}

class TTLock {
  constructor(opts = {}) {
    this.fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    this.clientId = opts.clientId || ENV.TTLOCK_CLIENT_ID || '';
    this.clientSecret = opts.clientSecret || ENV.TTLOCK_CLIENT_SECRET || '';
    this.username = opts.username || ENV.TTLOCK_USER || '';
    this.password = opts.password || ENV.TTLOCK_PASS || '';
    this.base = apiBase(opts.region || ENV.TTLOCK_REGION || 'eu', opts.apiBase || ENV.TTLOCK_API_BASE);
    this.tokenProvider = opts.tokenProvider || null;
    this.token = null;
    this.tokenExp = 0;
    this.demo = !this.tokenProvider && !(this.clientId && this.clientSecret && this.username && this.password);
  }

  /** TTLock requires the password as a lowercase MD5 hex digest. */
  static md5(s) { return md5Hex(s); }

  /** One-time exchange of account credentials for tokens (password grant). */
  static login({ region, apiBase: override, fetch = (...a) => globalThis.fetch(...a), clientId, clientSecret, username, password }) {
    return oauthToken({ base: apiBase(region, override), fetch, clientId, clientSecret, form: { username, password: md5Hex(password) } });
  }

  static refresh({ region, apiBase: override, fetch = (...a) => globalThis.fetch(...a), clientId, clientSecret, refreshToken }) {
    return oauthToken({ base: apiBase(region, override), fetch, clientId, clientSecret, form: { grant_type: 'refresh_token', refresh_token: refreshToken } });
  }

  now() { return Date.now(); }

  async getToken({ force = false } = {}) {
    if (this.demo) return 'DEMO';
    if (this.tokenProvider) return this.tokenProvider({ force });
    if (!force && this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const t = await oauthToken({
      base: this.base, fetch: this.fetch, clientId: this.clientId, clientSecret: this.clientSecret,
      form: { username: this.username, password: md5Hex(this.password) },
    });
    this.token = t.accessToken;
    this.tokenExp = t.expiresAt;
    return this.token;
  }

  async call(path, params = {}, method = 'GET', { retried = false } = {}) {
    if (this.demo) return { __demo: true };
    const token = await this.getToken({ force: retried });
    const all = { clientId: this.clientId, accessToken: token, date: this.now(), ...params };
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined && v !== null && v !== ''))
    );
    const url = method === 'GET' ? `${this.base}${path}?${qs}` : `${this.base}${path}`;
    const init = method === 'GET'
      ? { method }
      : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs };
    const r = await this.fetch(url, init);
    let j;
    try { j = await r.json(); } catch { throw new TTLockError(path, 90000, `HTTP ${r.status}, not JSON`); }
    // A token revoked elsewhere (password change, re-login): get a fresh one once.
    if (j.errcode && TOKEN_ERRORS.has(Number(j.errcode)) && !retried) return this.call(path, params, method, { retried: true });
    if (j.errcode) throw new TTLockError(path, j.errcode, j.errmsg);
    return j;
  }

  // ---- Locks (doors) -------------------------------------------------
  listLocks(pageNo = 1, pageSize = 100, groupId) {
    return this.call('/v3/lock/list', { pageNo, pageSize, groupId });
  }
  lockDetail(lockId) { return this.call('/v3/lock/detail', { lockId }); }

  // ---- Remote unlock / lock (needs a gateway or WiFi lock) ------------
  unlock(lockId) { return this.call('/v3/lock/unlock', { lockId }, 'POST'); }
  lock(lockId)   { return this.call('/v3/lock/lock',   { lockId }, 'POST'); }

  // ---- Groups (used as Sites) ----------------------------------------
  listGroups() { return this.call('/v3/group/list', {}); }

  // ---- Passcodes (PIN credentials) -----------------------------------
  /** keyboardPwdType: 1=one-time 2=permanent 3=period ... */
  createPasscode({ lockId, keyboardPwdName, keyboardPwdType = 3, startDate, endDate }) {
    return this.call('/v3/keyboardPwd/get', {
      lockId, keyboardPwdName, keyboardPwdType, startDate, endDate,
    }, 'POST');
  }
  listPasscodes(lockId, pageNo = 1, pageSize = 100) {
    return this.call('/v3/lock/listKeyboardPwd', { lockId, pageNo, pageSize });
  }
  /**
   * deleteType: 1 = via the app over Bluetooth (TTLock's DEFAULT — the cloud
   * then only forgets the code and it keeps working on the lock!),
   * 2 = via gateway/WiFi, 3 = NB-IoT. A cloud-side revoke must send 2.
   */
  deletePasscode(lockId, keyboardPwdId, { deleteType = 2 } = {}) {
    return this.call('/v3/keyboardPwd/delete', { lockId, keyboardPwdId, deleteType }, 'POST');
  }
  /** Is this passcode still registered on the lock? (pages through the list) */
  async passcodeExists(lockId, keyboardPwdId, { maxPages = 20 } = {}) {
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const r = await this.listPasscodes(lockId, pageNo, 100);
      const list = r.list || [];
      if (list.some(p => String(p.keyboardPwdId) === String(keyboardPwdId))) return true;
      if (list.length < 100 || pageNo >= (r.pages || Infinity)) return false;
    }
    throw new Error(`passcode list for lock ${lockId} exceeds ${maxPages} pages; cannot verify`);
  }

  // ---- eKeys (mobile credentials) ------------------------------------
  sendEkey({ lockId, receiverUsername, keyName, startDate, endDate, remoteEnable = 1 }) {
    return this.call('/v3/key/send', {
      lockId, receiverUsername, keyName, startDate, endDate, remoteEnable,
    }, 'POST');
  }
  listKeys(lockId, pageNo = 1, pageSize = 100) {
    return this.call('/v3/lock/listKey', { lockId, pageNo, pageSize });
  }
  deleteKey(keyId) { return this.call('/v3/key/delete', { keyId }, 'POST'); }

  // ---- Audit trail ----------------------------------------------------
  records(lockId, { startDate, endDate, pageNo = 1, pageSize = 200, recordType } = {}) {
    return this.call('/v3/lockRecord/list', {
      lockId, startDate, endDate, pageNo, pageSize, recordType,
    });
  }

  /** Lock clock (needs a gateway). Used to check DST/clock drift on real devices. */
  queryDate(lockId) { return this.call('/v3/lock/queryDate', { lockId }); }

  /** All locks of the account (pages of 100). */
  async listAllLocks({ maxPages = 50 } = {}) {
    const out = [];
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const r = await this.listLocks(pageNo, 100);
      out.push(...(r.list || []));
      if ((r.list || []).length < 100 || pageNo >= (r.pages || Infinity)) break;
    }
    return out;
  }

  // ---- Gateways --------------------------------------------------------
  listGateways(pageNo = 1, pageSize = 100) {
    return this.call('/v3/gateway/list', { pageNo, pageSize });
  }
}

/** TTLock record type -> human label. From cloud/lockRecord docs. */
const RECORD_TYPES = {
  1: 'App unlock', 4: 'Passcode unlock', 7: 'IC card unlock', 8: 'Fingerprint unlock',
  9: 'Wireless keypad', 10: 'Auto lock', 11: 'App lock', 12: 'Gateway unlock',
  46: 'Remote unlock', 47: 'Remote lock', 55: 'Remote control (fob)',
  '-5': 'Face unlock', '-4': 'QR code unlock', 123: 'Network exception',
};

module.exports = { TTLock, TTLockError, ERR, TOKEN_ERRORS, RECORD_TYPES, apiBase };
