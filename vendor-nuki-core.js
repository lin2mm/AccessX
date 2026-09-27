/**
 * Nuki as a lock vendor — runtime-agnostic (Node server + Worker).
 * ====================================================================
 * Same interface as vendor-ttlock-core.js:
 *   listLocks() unlock(id) createPasscode(o) deletePasscode(id, ref)
 *   listPasscodes(id) records(id) info() status()
 *
 * How Nuki differs, and what this adapter does about it (docs/25-NUKI.md):
 *  - Writes are asynchronous. A new keypad code is confirmed by listing the
 *    lock's auths until it appears. If it never appears, the caller gets an
 *    error, no code is registered, and nobody ever saw the digits.
 *  - AccessX chooses the digits (Nuki needs them in the request): 6 digits,
 *    1–9, not starting "12", unique on that keypad.
 *  - "Gateway" means "online now" (serverState 0): Nuki runs commands only
 *    for online devices. An offline lock is handled like a door without a
 *    gateway: a revoke there becomes pending removal, never a silent success.
 *  - Nuki's auth list includes the digits of every code. They never leave
 *    this file: listPasscodes() returns names and windows only.
 *  - Activity logs have no code digits, so visitor arrivals cannot be
 *    matched from Nuki records, and Nuki log actions are not TTLock alarm
 *    types. Both are listed as capabilities (false).
 */
const { codeOf, validKeypadCode, LOG_ACTIONS, LOG_TRIGGERS } = require('./nuki');
const { VendorUnavailableError, NoGatewayError } = require('./vendor-ttlock-core');

const KEYPAD_CODE = 13;
const NAME_MAX = 20; // Nuki: auth names up to 20 characters
const AUTHS_MAX = 200; // newer devices; older ones hold 100

class VendorRequestError extends Error {
  constructor(status, message) { super(message); this.name = 'VendorRequestError'; this.status = status; }
}

/** A random keypad code Nuki accepts and this keypad does not have yet. */
function newKeypadCode(used, randomInt = defaultRandomInt) {
  for (let i = 0; i < 1000; i++) {
    let s = '';
    for (let d = 0; d < 6; d++) s += String(1 + randomInt(9));
    if (validKeypadCode(s) && !used.has(s)) return s;
  }
  throw new VendorRequestError(409, 'could not find a free keypad code on this lock');
}
function defaultRandomInt(n) {
  // Rejection sampling over one byte: uniform in [0, n).
  const buf = new Uint8Array(1);
  const limit = 256 - (256 % n);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

const mapLock = s => {
  const state = s.state || {};
  const config = s.config || {};
  const charge = Number.isFinite(Number(state.batteryCharge)) && state.batteryCharge !== null ? Number(state.batteryCharge) : (state.batteryCritical ? 10 : null);
  return {
    lockId: Number(s.smartlockId), lockAlias: String(s.name || s.smartlockId), electricQuantity: charge,
    hasGateway: Number(s.serverState) === 0 ? 1 : 0, online: Number(s.serverState) === 0,
    keypad: Boolean(config.keypadPaired || config.keypad2Paired), cyclic: false, vendor: 'nuki', model: s.type,
  };
};

const iso = v => (v ? new Date(v).toISOString() : null);
/** One keypad code as the Nuki cloud lists it. Never the digits. */
const mapPasscode = a => {
  const windowed = Boolean(a.allowedFromDate || a.allowedUntilDate);
  const weekly = (a.allowedWeekDays !== undefined && a.allowedWeekDays !== null && Number(a.allowedWeekDays) !== 127) || Number(a.allowedFromTime) > 0 || Number(a.allowedUntilTime) > 0;
  return {
    ref: String(a.id), name: String(a.name || '').slice(0, 100) + (a.enabled === false ? ' (disabled)' : ''),
    type: weekly ? 'cyclic' : windowed ? 'period' : 'permanent',
    startAt: iso(a.allowedFromDate), endAt: iso(a.allowedUntilDate), createdBy: null, createdAt: iso(a.creationDate),
  };
};

/** A Nuki log entry in the record shape the UI shows (time, who, what). */
const mapRecord = r => {
  const at = Date.parse(r.date);
  return {
    recordId: r.id, lockDate: at, serverDate: at, username: r.name || null,
    success: Number(r.state) === 0 ? 1 : 0, recordType: `nuki:${r.action}`,
    typeLabel: `${LOG_ACTIONS[r.action] || `action ${r.action}`}${LOG_TRIGGERS[r.trigger] ? ` (${LOG_TRIGGERS[r.trigger]})` : ''}`,
  };
};

/**
 * @param nuki           Nuki client (nuki.js)
 * @param opts.pollMs    wait between checks after creating a code
 * @param opts.pollTries checks before giving up
 */
function createNukiVendor(nuki, {
  label = 'Nuki Web', cacheMs = 60e3, onAuthFailure = null, now = () => Date.now(),
  pollMs = 1500, pollTries = 8, sleep = ms => new Promise(r => setTimeout(r, ms)), randomInt = defaultRandomInt,
} = {}) {
  let cache = null;
  const guard = async fn => {
    try {
      return await fn();
    } catch (error) {
      if (error && error.auth) {
        if (onAuthFailure) await onAuthFailure(error);
        throw new VendorUnavailableError('Nuki rejected this account\'s API token — an owner must connect Nuki again with a new token', { reason: 'needs_reconnect', cause: error });
      }
      if (error && error.transient) throw new VendorUnavailableError(`Nuki is not reachable right now (${error.status ? `HTTP ${error.status}` : error.message}); try again shortly`, { reason: 'unavailable', cause: error });
      throw error;
    }
  };
  const locks = async () => {
    if (cache && now() - cache.at < cacheMs) return cache.locks.map(l => ({ ...l }));
    const list = (await guard(() => nuki.listSmartlocks())).map(mapLock);
    cache = { at: now(), locks: list };
    return list.map(l => ({ ...l }));
  };
  const lockOf = async lockId => {
    const l = (await locks()).find(x => x.lockId === Number(lockId));
    if (!l) throw new VendorRequestError(404, `lock ${lockId} is not in this Nuki account`);
    return l;
  };
  const keypadAuths = async lockId => (await guard(() => nuki.listAuths(lockId))).filter(a => Number(a.type) === KEYPAD_CODE);

  return {
    kind: 'nuki',
    demo: false,
    status: () => ({ mode: `LIVE (${label})`, region: 'eu' }),
    listLocks: locks,
    invalidate() { cache = null; },
    async unlock(lockId) {
      const l = await lockOf(lockId);
      if (!l.online) throw new NoGatewayError(`Nuki lock ${lockId} is offline: it cannot be opened remotely right now`);
      await guard(() => nuki.unlock(lockId));
      return { accepted: true, note: 'Nuki runs commands asynchronously: the lock opens within a few seconds if it is reachable' };
    },
    async createPasscode({ lockId, name, startAt, endAt }) {
      const l = await lockOf(lockId);
      if (!l.keypad) throw new VendorRequestError(409, `Nuki lock "${l.lockAlias}" has no keypad paired: codes need a Nuki Keypad`);
      // Unlike TTLock's offline codes, a Nuki code must be synced to the lock: offline, it would not open the door.
      if (!l.online) throw new VendorRequestError(409, `Nuki lock "${l.lockAlias}" is offline: a new code would not reach it. Bring the lock (or its bridge) online and try again`);
      const all = await guard(() => nuki.listAuths(lockId));
      if (all.length >= AUTHS_MAX) throw new VendorRequestError(409, `Nuki lock "${l.lockAlias}" is full (${all.length} authorizations): remove old codes first (Activity → Passcode sweep)`);
      const used = new Set(all.filter(a => Number(a.type) === KEYPAD_CODE).map(codeOf).filter(Boolean));
      const code = newKeypadCode(used, randomInt);
      await guard(() => nuki.createAuth(lockId, {
        name: String(name || 'AccessX').slice(0, NAME_MAX), type: KEYPAD_CODE, code: Number(code),
        allowedFromDate: iso(startAt), allowedUntilDate: iso(endAt),
        allowedWeekDays: 127, allowedFromTime: 0, allowedUntilTime: 0, // the window applies only with allowedWeekDays set
      }));
      // Asynchronous: the code exists once the lock's list shows it.
      for (let i = 0; i < pollTries; i++) {
        if (i) await sleep(pollMs);
        const found = (await keypadAuths(lockId)).find(a => codeOf(a) === code);
        if (found) return { keyboardPwd: code, keyboardPwdId: String(found.id) };
      }
      throw new VendorUnavailableError(`Nuki accepted the code for "${l.lockAlias}" but did not confirm it: nothing was registered and nobody saw the digits. Try again; if it appears later, the passcode sweep lists it`, { reason: 'unconfirmed' });
    },
    async deletePasscode(lockId, ref) {
      const l = await lockOf(lockId);
      if (!l.online) throw new NoGatewayError(`Nuki lock ${lockId} is offline: remove the code at the lock (Nuki app over Bluetooth)`);
      try {
        await guard(() => nuki.deleteAuth(lockId, ref));
        return { deleted: true };
      } catch (error) {
        if (error.status === 404) return { deleted: true, alreadyGone: true };
        if (error instanceof VendorUnavailableError && error.reason === 'needs_reconnect') throw error;
        let still;
        try { still = (await guard(() => nuki.listAuths(lockId))).some(a => String(a.id) === String(ref)); } catch { throw error; }
        if (!still) return { deleted: true, alreadyGone: true };
        throw error;
      }
    },
    listPasscodes: async lockId => (await keypadAuths(lockId)).map(mapPasscode),
    records: async lockId => (await guard(() => nuki.logs(lockId, 50))).map(mapRecord),
    async info() {
      return {
        active: 'nuki', available: ['nuki', 'demo'],
        capabilities: {
          listLocks: true, unlock: true, passcodes: true, listPasscodes: true, records: true, recordsMax: 50, gateways: true,
          cyclicVerified: false, keypadRequired: true, arrivalsFromRecords: false, alarmsFromRecords: false, asyncWrites: true,
        },
        health: { vendor: 'nuki', ok: true, mode: label },
      };
    },
    mirror: null,
  };
}

module.exports = { createNukiVendor, newKeypadCode, mapLock, mapPasscode, mapRecord, VendorRequestError, KEYPAD_CODE, NAME_MAX };
