/**
 * Fake TTLock cloud for tests and the Worker smoke test. Models the parts
 * that have bitten us, following https://euopen.ttlock.com/doc:
 *  - /oauth2/token takes snake_case client_id/client_secret and an MD5
 *    password; v3 calls take camelCase clientId + accessToken + date (±5 min);
 *  - HTTP 200 with {errcode, errmsg} on errors;
 *  - a token only reaches its own account's locks (20002 not lock admin);
 *  - keyboardPwd/delete deleteType=1 (the default!) only makes the CLOUD
 *    forget the code — it keeps working on the device; 2 needs a gateway
 *    (-2012 without one);
 *  - tokens expire / get revoked (10004), refresh tokens rotate (10011).
 *
 *   const cloud = createFakeTTLock({ apps: { app1: 'secret1' }, accounts: {...} });
 *   cloud.fetch(url, init)          // drop-in fetch
 *   await cloud.listen(0)           // or a real HTTP server (Worker smoke)
 */
const http = require('node:http');
const crypto = require('node:crypto');

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const rand = () => crypto.randomBytes(16).toString('hex');

function createFakeTTLock({ apps = { 'platform-app': 'platform-secret' }, accounts = {}, locks = {}, tokenTtlSec = 7776000, now = () => Date.now() } = {}) {
  // accounts: { username: { password, uid, lockIds: [...] } }
  // locks: { lockId: { lockAlias, hasGateway, electricQuantity } }
  const state = {
    accounts: Object.fromEntries(Object.entries(accounts).map(([u, a]) => [u, { ...a, passwordMd5: md5(a.password) }])),
    locks: Object.fromEntries(Object.entries(locks).map(([id, l]) => [id, { ...l, lockId: Number(id), cloud: new Map(), device: new Map() }])),
    tokens: new Map(), // accessToken → { username, expiresAt, revoked }
    refresh: new Map(), // refreshToken → username
    calls: [],
    rateLimitNext: 0,
    nextPwdId: 5000,
  };

  function issue(username) {
    const accessToken = rand();
    const refreshToken = rand();
    state.tokens.set(accessToken, { username, expiresAt: now() + tokenTtlSec * 1000 });
    state.refresh.set(refreshToken, username);
    return { access_token: accessToken, refresh_token: refreshToken, uid: state.accounts[username].uid, expires_in: tokenTtlSec, scope: 'user,key,room', token_type: 'Bearer' };
  }

  function oauth(p) {
    if (!apps[p.client_id]) return { errcode: 10000, errmsg: 'invalid client_id' };
    if (apps[p.client_id] !== p.client_secret) return { errcode: 10001, errmsg: 'invalid client' };
    if (p.grant_type === 'refresh_token') {
      const username = state.refresh.get(p.refresh_token);
      if (!username) return { errcode: 10011, errmsg: 'invalid refresh_token' };
      state.refresh.delete(p.refresh_token); // rotate: single use
      return issue(username);
    }
    const acct = state.accounts[p.username];
    if (!acct || acct.passwordMd5 !== p.password) return { errcode: 10007, errmsg: 'invalid account' };
    return issue(p.username);
  }

  function v3(path, p) {
    if (state.rateLimitNext > 0) { state.rateLimitNext--; return { errcode: 30006, errmsg: 'call limit exceeded' }; }
    if (!apps[p.clientId]) return { errcode: 10000, errmsg: 'invalid client_id' };
    const tok = state.tokens.get(p.accessToken);
    if (!tok) return { errcode: 10003, errmsg: 'invalid token' };
    if (tok.revoked || tok.expiresAt < now()) return { errcode: 10004, errmsg: 'invalid grant' };
    if (!p.date || Math.abs(Number(p.date) - now()) > 5 * 60e3) return { errcode: 80000, errmsg: 'date must be current time, in 5 minutes' };
    const acct = state.accounts[tok.username];
    const mine = id => acct.lockIds.map(Number).includes(Number(id));
    const lock = () => {
      const l = state.locks[Number(p.lockId)];
      if (!l || !mine(p.lockId)) return null;
      return l;
    };
    switch (path) {
      case '/v3/lock/list': {
        const list = acct.lockIds.map(id => state.locks[id]).filter(Boolean)
          .map(l => ({ lockId: l.lockId, lockAlias: l.lockAlias, electricQuantity: l.electricQuantity, hasGateway: l.hasGateway ? 1 : 0, groupName: l.groupName }));
        const pageSize = Number(p.pageSize) || 20; const pageNo = Number(p.pageNo) || 1;
        return { list: list.slice((pageNo - 1) * pageSize, pageNo * pageSize), pageNo, pageSize, pages: Math.max(1, Math.ceil(list.length / pageSize)), total: list.length };
      }
      case '/v3/lock/unlock': {
        const l = lock(); if (!l) return { errcode: 20002, errmsg: 'not lock admin' };
        return l.hasGateway ? { errcode: 0 } : { errcode: -2012, errmsg: 'lock not connected to any gateway' };
      }
      case '/v3/keyboardPwd/get': {
        const l = lock(); if (!l) return { errcode: 20002, errmsg: 'not lock admin' };
        const keyboardPwdId = state.nextPwdId++;
        const code = { keyboardPwdId, keyboardPwd: String(100000 + (keyboardPwdId * 7919) % 899999), keyboardPwdName: p.keyboardPwdName, startDate: Number(p.startDate), endDate: Number(p.endDate) };
        // Period passcodes are algorithmic: valid on the device without a gateway.
        l.cloud.set(keyboardPwdId, code); l.device.set(keyboardPwdId, code);
        return { keyboardPwd: code.keyboardPwd, keyboardPwdId };
      }
      case '/v3/keyboardPwd/delete': {
        const l = lock(); if (!l) return { errcode: 20002, errmsg: 'not lock admin' };
        const id = Number(p.keyboardPwdId);
        const type = Number(p.deleteType || 1);
        if (type === 2) {
          if (!l.hasGateway) return { errcode: -2012, errmsg: 'lock not connected to any gateway' };
          if (!l.cloud.has(id) && !l.device.has(id)) return { errcode: 1, errmsg: 'failed' };
          l.cloud.delete(id); l.device.delete(id); return { errcode: 0 };
        }
        // deleteType=1: "delete via app over Bluetooth first" — the cloud just forgets.
        if (!l.cloud.has(id)) return { errcode: 1, errmsg: 'failed' };
        l.cloud.delete(id); return { errcode: 0 };
      }
      case '/v3/lock/listKeyboardPwd': {
        const l = lock(); if (!l) return { errcode: 20002, errmsg: 'not lock admin' };
        const list = [...l.cloud.values()];
        const pageSize = Number(p.pageSize) || 20; const pageNo = Number(p.pageNo) || 1;
        return { list: list.slice((pageNo - 1) * pageSize, pageNo * pageSize), pageNo, pageSize, pages: Math.max(1, Math.ceil(list.length / pageSize)), total: list.length };
      }
      case '/v3/lockRecord/list': {
        const l = lock(); if (!l) return { errcode: 20002, errmsg: 'not lock admin' };
        return { list: [{ recordId: 1, lockId: l.lockId, recordType: 4, success: 1, username: 'keypad', lockDate: now() - 60e3 }], pageNo: 1, pageSize: 100, pages: 1, total: 1 };
      }
      case '/v3/lock/queryDate': {
        const l = lock(); if (!l) return { errcode: 20002, errmsg: 'not lock admin' };
        if (!l.hasGateway) return { errcode: -2012, errmsg: 'lock not connected to any gateway' };
        return { date: now() + (l.clockSkewMs || 0) };
      }
      default: return { errcode: -3, errmsg: 'Invalid Parameter.' };
    }
  }

  function dispatch(pathname, params) {
    state.calls.push({ path: pathname, params });
    return pathname === '/oauth2/token' ? oauth(params) : v3(pathname, params);
  }

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const params = Object.fromEntries(init.body ? new URLSearchParams(String(init.body)) : u.searchParams);
    const body = dispatch(u.pathname, params);
    return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  }

  let server = null;
  async function listen(port = 0, host = '127.0.0.1') {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const params = Object.fromEntries(req.method === 'GET' ? u.searchParams : new URLSearchParams(data));
        const body = dispatch(u.pathname, params);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise(resolve => server.listen(port, host, resolve));
    return `http://${host}:${server.address().port}`;
  }
  const close = () => new Promise(resolve => (server ? server.close(() => resolve()) : resolve()));

  return {
    fetch, listen, close, state,
    /** simulate a password change / revoked authorization at TTLock */
    revokeAccount(username) {
      for (const t of state.tokens.values()) if (t.username === username) t.revoked = true;
      for (const [r, u] of state.refresh) if (u === username) state.refresh.delete(r);
    },
    expireTokens() { for (const t of state.tokens.values()) t.expiresAt = now() - 1; },
    setPassword(username, password) { state.accounts[username].passwordMd5 = md5(password); },
    onDevice: (lockId, pwdId) => state.locks[lockId].device.has(Number(pwdId)),
    inCloud: (lockId, pwdId) => state.locks[lockId].cloud.has(Number(pwdId)),
    callsTo: path => state.calls.filter(c => c.path === path),
  };
}

/** Standard fixture: the seed's Riverside locks for one account, Northgate for another. */
function demoFixture(opts = {}) {
  return createFakeTTLock({
    apps: { 'platform-app': 'platform-secret', 'own-app': 'own-secret' },
    accounts: {
      'riverside-admin': { password: 'river-pass-1', uid: '71001', lockIds: [9001, 9002, 9003, 9004] },
      'northgate-admin': { password: 'north-pass-1', uid: '71002', lockIds: [9101, 9102] },
    },
    locks: {
      9001: { lockAlias: 'Main Entrance', hasGateway: true, electricQuantity: 80, groupName: 'Riverside Office' },
      9002: { lockAlias: 'Server Room', hasGateway: true, electricQuantity: 90, groupName: 'Riverside Office' },
      9003: { lockAlias: 'Warehouse Side Door', hasGateway: true, electricQuantity: 40, groupName: 'Riverside Office' },
      9004: { lockAlias: 'Cleaner Cupboard', hasGateway: false, electricQuantity: 15, groupName: 'Riverside Office' },
      9101: { lockAlias: 'Gym Front Door', hasGateway: true, electricQuantity: 66, groupName: 'Northgate Gym' },
      9102: { lockAlias: 'Gym Staff Office', hasGateway: true, electricQuantity: 88, groupName: 'Northgate Gym' },
    },
    ...opts,
  });
}

module.exports = { createFakeTTLock, demoFixture };

if (require.main === module) {
  // Standalone (Worker smoke): node support/fake-ttlock.js [port]
  const cloud = demoFixture();
  cloud.listen(Number(process.argv[2]) || 4001, '0.0.0.0').then(url => console.log(`fake TTLock cloud on ${url}`));
}
