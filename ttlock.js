/**
 * TTLock Cloud API v3 client
 * Docs: https://euopen.ttlock.com/document/doc
 *
 * REAL endpoints, REAL parameter names, taken from the live TTLock docs.
 * Set TTLOCK_CLIENT_ID / TTLOCK_CLIENT_SECRET / TTLOCK_USER / TTLOCK_PASS
 * to run against the real cloud. Without them the server runs in DEMO mode.
 */
const crypto = require('crypto');

const REGION = {
  eu: { api: 'https://euapi.ttlock.com', oauth: 'https://euapi.ttlock.com' },
  cn: { api: 'https://api.sciener.com',  oauth: 'https://api.sciener.com'  },
};

class TTLock {
  constructor(opts = {}) {
    this.clientId = opts.clientId || process.env.TTLOCK_CLIENT_ID || '';
    this.clientSecret = opts.clientSecret || process.env.TTLOCK_CLIENT_SECRET || '';
    this.username = opts.username || process.env.TTLOCK_USER || '';
    this.password = opts.password || process.env.TTLOCK_PASS || '';
    this.base = (REGION[opts.region || process.env.TTLOCK_REGION || 'eu']).api;
    this.token = null;
    this.tokenExp = 0;
    this.demo = !(this.clientId && this.clientSecret && this.username && this.password);
  }

  /** TTLock requires the password as a lowercase MD5 hex digest. */
  static md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

  now() { return Date.now(); }

  async getToken() {
    if (this.demo) return 'DEMO';
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const body = new URLSearchParams({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      username: this.username,
      password: TTLock.md5(this.password),
    });
    const r = await fetch(`${this.base}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json();
    if (j.errcode) throw new Error(`TTLock auth ${j.errcode}: ${j.errmsg}`);
    this.token = j.access_token;
    this.tokenExp = Date.now() + (j.expires_in || 7776000) * 1000;
    return this.token;
  }

  async call(path, params = {}, method = 'GET') {
    if (this.demo) return { __demo: true };
    const token = await this.getToken();
    const all = { clientId: this.clientId, accessToken: token, date: this.now(), ...params };
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined && v !== null))
    );
    const url = method === 'GET' ? `${this.base}${path}?${qs}` : `${this.base}${path}`;
    const init = method === 'GET'
      ? { method }
      : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs };
    const r = await fetch(url, init);
    const j = await r.json();
    if (j.errcode) throw new Error(`TTLock ${path} ${j.errcode}: ${j.errmsg}`);
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
  deletePasscode(lockId, keyboardPwdId) {
    return this.call('/v3/keyboardPwd/delete', { lockId, keyboardPwdId }, 'POST');
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

module.exports = { TTLock, RECORD_TYPES };
