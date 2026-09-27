/**
 * Fake Nuki Web API for tests and the Worker smoke test. Models what the
 * adapter must get right (docs.nuki.io, developer.nuki.io):
 *  - Bearer API tokens; a token reaches only its account's locks (401 otherwise);
 *  - writes are ASYNCHRONOUS: PUT /smartlock/{id}/auth returns 204 and the auth
 *    shows up in GET only after `confirmAfterGets` list calls (or never);
 *  - keypad codes (type 13): 6 digits 1–9, not starting 12, unique per keypad,
 *    a keypad must be paired; names up to 20 characters;
 *  - a date window without allowedWeekDays is IGNORED by Nuki (recorded here as
 *    `windowIgnored`, so tests can prove the adapter sends it);
 *  - `code` comes back as an array (the Nov 2024 change) unless configured;
 *  - offline locks (serverState 4) do not run actions; 429 on demand.
 *
 *   const cloud = nukiFixture();
 *   const base = await cloud.listen(0);   // http://127.0.0.1:port
 */
const http = require('node:http');

function createFakeNuki({ accounts = {}, locks = {}, codeShape = 'array', confirmAfterGets = 1, now = () => Date.now() } = {}) {
  // accounts: { token: { accountId, email, name, lockIds } }
  // locks: { id: { name, serverState, keypad, batteryCharge, batteryCritical, type } }
  const state = {
    accounts: { ...accounts },
    locks: Object.fromEntries(Object.entries(locks).map(([id, l]) => [id, { serverState: 0, keypad: true, type: 4, ...l, smartlockId: Number(id), auths: new Map(), pending: [], logs: [] }])),
    calls: [], rateLimitNext: 0, neverConfirm: new Set(), nextAuthId: 1, confirmAfterGets,
  };
  const shape = code => (codeShape === 'array' ? [Number(code)] : codeShape === 'string' ? String(code) : Number(code));
  const publicAuth = a => ({ ...a, code: a.type === 13 ? shape(a.code) : undefined });

  function lockView(l) {
    return {
      smartlockId: l.smartlockId, accountId: 1, type: l.type, name: l.name, serverState: l.serverState, adminPinState: 0,
      state: { mode: 2, state: 1, trigger: 0, lastAction: 2, batteryCritical: Boolean(l.batteryCritical), batteryCharge: l.batteryCharge ?? null, keypadBatteryCritical: false, doorState: 0 },
      config: { name: l.name, keypadPaired: Boolean(l.keypad) },
    };
  }

  async function route(method, url, headers, body) {
    const u = new URL(url, 'http://fake');
    const path = u.pathname;
    state.calls.push({ method, path, body });
    if (state.rateLimitNext > 0) { state.rateLimitNext -= 1; return [429, { detailMessage: 'Too many requests' }]; }
    const token = String(headers.authorization || '').replace(/^Bearer\s+/i, '');
    const acct = state.accounts[token];
    if (!acct || acct.revoked) return [401, { detailMessage: 'Unauthorized' }];
    const mine = id => acct.lockIds.includes(Number(id)) && state.locks[id];
    // A token generated without the smartlock.auth / smartlock.action scopes.
    if (acct.readOnly && /^\/smartlock\/\d+\/(auth|action)/.test(path)) return [403, { detailMessage: 'Forbidden' }];
    if (method === 'GET' && path === '/account') return [200, { accountId: acct.accountId, email: acct.email, name: acct.name, type: 0 }];
    if (method === 'GET' && path === '/smartlock') return [200, acct.lockIds.filter(id => state.locks[id]).map(id => lockView(state.locks[id]))];
    let m = path.match(/^\/smartlock\/(\d+)$/);
    if (m && method === 'GET') return mine(m[1]) ? [200, lockView(state.locks[m[1]])] : [404, { detailMessage: 'Not found' }];
    m = path.match(/^\/smartlock\/(\d+)\/action\/(unlock|lock)$/);
    if (m && method === 'POST') {
      const l = mine(m[1]);
      if (!l) return [404, { detailMessage: 'Not found' }];
      if (l.serverState !== 0) return [405, { detailMessage: 'Smartlock is offline' }];
      l.logs.unshift({ id: `log${l.logs.length + 1}`, smartlockId: l.smartlockId, action: m[2] === 'unlock' ? 1 : 2, trigger: 4, state: 0, name: acct.name, date: new Date(now()).toISOString() });
      return [204, null];
    }
    m = path.match(/^\/smartlock\/(\d+)\/auth$/);
    if (m) {
      const l = mine(m[1]);
      if (!l) return [404, { detailMessage: 'Not found' }];
      if (method === 'GET') {
        // Pending creations become visible after N list calls (asynchronous writes).
        for (const p of [...l.pending]) {
          if (state.neverConfirm.has(l.smartlockId)) continue;
          p.gets += 1;
          if (p.gets > state.confirmAfterGets) { l.auths.set(p.auth.id, p.auth); l.pending.splice(l.pending.indexOf(p), 1); }
        }
        return [200, [...l.auths.values()].map(publicAuth)];
      }
      if (method === 'PUT') {
        const b = body || {};
        if (!b.name || String(b.name).length > 20) return [400, { detailMessage: "The supplied value for parameter 'name' is not valid" }];
        if (Number(b.type) === 13) {
          const code = String(b.code || '');
          if (!l.keypad) return [400, { detailMessage: 'No keypad paired' }];
          if (!/^[1-9]{6}$/.test(code) || code.startsWith('12')) return [400, { detailMessage: "The supplied value for parameter 'code' is not valid" }];
          const taken = [...l.auths.values(), ...l.pending.map(p => p.auth)].some(a => a.type === 13 && String(a.code) === code);
          if (taken) return [409, { detailMessage: 'Code already in use' }];
        }
        if (l.auths.size + l.pending.length >= 200) return [400, { detailMessage: 'Maximum number of authorizations reached' }];
        const n = state.nextAuthId++;
        const windowIgnored = Boolean(b.allowedFromDate || b.allowedUntilDate) && (b.allowedWeekDays === undefined || b.allowedWeekDays === null);
        const auth = {
          id: `a${String(n).padStart(23, '0')}`, smartlockId: l.smartlockId, authId: n, type: Number(b.type) || 0, name: b.name, enabled: true,
          code: Number(b.type) === 13 ? Number(b.code) : undefined, remoteAllowed: Boolean(b.remoteAllowed),
          allowedFromDate: windowIgnored ? undefined : b.allowedFromDate, allowedUntilDate: windowIgnored ? undefined : b.allowedUntilDate,
          allowedWeekDays: b.allowedWeekDays, allowedFromTime: b.allowedFromTime || 0, allowedUntilTime: b.allowedUntilTime || 0,
          creationDate: new Date(now()).toISOString(), windowIgnored,
        };
        l.pending.push({ auth, gets: 0 });
        return [204, null];
      }
    }
    m = path.match(/^\/smartlock\/(\d+)\/auth\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const l = mine(m[1]);
      if (!l) return [404, { detailMessage: 'Not found' }];
      const id = decodeURIComponent(m[2]);
      if (!l.auths.has(id)) return [404, { detailMessage: 'Not found' }];
      l.auths.delete(id);
      return [204, null];
    }
    m = path.match(/^\/smartlock\/(\d+)\/log$/);
    if (m && method === 'GET') {
      const l = mine(m[1]);
      if (!l) return [404, { detailMessage: 'Not found' }];
      return [200, l.logs.slice(0, Math.min(Number(u.searchParams.get('limit')) || 20, 50))];
    }
    return [404, { detailMessage: 'Not found' }];
  }

  async function fetch(url, init = {}) {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    const [status, out] = await route((init.method || 'GET').toUpperCase(), url, headers, body);
    return new Response(out === null ? null : JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  }

  let server = null;
  function listen(port = 0, host = '127.0.0.1') {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', async () => {
        let body;
        try { body = raw ? JSON.parse(raw) : undefined; } catch { res.writeHead(400); res.end('{}'); return; }
        const [status, out] = await route(req.method, req.url, req.headers, body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(out === null ? '' : JSON.stringify(out));
      });
    });
    return new Promise(resolve => server.listen(port, host, () => resolve(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`)));
  }
  const close = () => new Promise(resolve => (server ? server.close(() => resolve()) : resolve()));

  return {
    fetch, listen, close, state,
    revoke(token) { state.accounts[token].revoked = true; },
    auths: lockId => [...state.locks[lockId].auths.values()],
    /** Someone adds a code in the Nuki app (visible at once). */
    addAppCode(lockId, { name, code, from, until }) {
      const n = state.nextAuthId++;
      const a = { id: `a${String(n).padStart(23, '0')}`, smartlockId: Number(lockId), authId: n, type: 13, name, enabled: true, code: Number(code), allowedFromDate: from, allowedUntilDate: until, allowedWeekDays: from ? 127 : undefined, creationDate: new Date(now()).toISOString() };
      state.locks[lockId].auths.set(a.id, a);
      return a.id;
    },
  };
}

/** The seed's Riverside doors in one Nuki account, the gym's in another; 9004 offline, 9002 without a keypad. */
function nukiFixture(opts = {}) {
  return createFakeNuki({
    accounts: {
      'nuki-river-token': { accountId: 81001, email: 'facilities@acme.example', name: 'Acme facilities', lockIds: [9001, 9002, 9003, 9004] },
      'nuki-gym-api-token': { accountId: 81002, email: 'gym@northgate.example', name: 'Northgate', lockIds: [9101, 9102] },
      'nuki-readonly-token': { accountId: 81003, email: 'viewer@acme.example', name: 'Read only', lockIds: [9101], readOnly: true },
    },
    locks: {
      9001: { name: 'Main Entrance', batteryCharge: 80 },
      9002: { name: 'Server Room', batteryCharge: 90, keypad: false },
      9003: { name: 'Warehouse Side Door', batteryCharge: 40 },
      9004: { name: 'Cleaner Cupboard', batteryCritical: true, serverState: 4 },
      9101: { name: 'Gym Front Door', batteryCharge: 66 },
      9102: { name: 'Gym Staff Office', batteryCharge: 88 },
    },
    ...opts,
  });
}

module.exports = { createFakeNuki, nukiFixture };

if (require.main === module) {
  const cloud = nukiFixture();
  cloud.listen(Number(process.argv[2]) || 4002, '0.0.0.0').then(url => console.log(`fake Nuki cloud on ${url}`));
}
