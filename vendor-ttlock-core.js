/**
 * TTLock as a lock vendor — runtime-agnostic (Node server + Worker).
 * Wraps a TTLock client (ttlock.js) in the vendor interface used by the
 * API and the reconciler:
 *   listLocks() unlock(id) createPasscode(o) deletePasscode(id, ref)
 *   records(id) info() status()
 *
 * Capability note: whether a lock supports cyclic (weekly) credentials is
 * model-dependent. Until it is verified per model it is reported as
 * false, so the policy compiler stays conservative.
 */
const { ERR, TOKEN_ERRORS, RECORD_TYPES } = require('./ttlock');

/** The lock is not reachable from the cloud: the code must be removed on site. */
class NoGatewayError extends Error {
  constructor(message) { super(message); this.code = 'NO_GATEWAY'; }
}

/**
 * The tenant's lock vendor cannot be used right now (token revoked, TTLock
 * down, account disconnected). Surfaces as HTTP 503 with a reason the
 * owner can act on — never as a 500 or an empty door list.
 */
/** Network failure, timeout, a gateway error page (not JSON) or TTLock's call limit: retry later. */
function isTransient(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  if (error.name === 'TypeError' && /fetch/i.test(String(error.message))) return true; // Node "fetch failed", Workers "Network connection lost"
  if (/network connection lost/i.test(String(error.message))) return true;
  return error.errcode === 90000 || error.errcode === 30006;
}
const transientWhy = error => (error.errcode === 30006 ? 'call limit exceeded'
  : error.errcode === 90000 ? 'bad gateway response'
    : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timed out' : 'network error');

class VendorUnavailableError extends Error {
  constructor(message, { reason = 'unavailable', cause } = {}) {
    super(message);
    this.status = 503;
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

/**
 * Idempotent delete. Retries and timeouts make "delete" ambiguous: the
 * first attempt may have succeeded before the response was lost, or
 * someone removed the code in the TTLock app. So on any failure other
 * than "no gateway" we ask the lock's passcode list — if the code is not
 * there, the goal (code no longer works) is reached and we report success.
 */
async function deletePasscodeIdempotent(tt, lockId, ref) {
  try {
    await tt.deletePasscode(lockId, ref, { deleteType: 2 });
    return { deleted: true };
  } catch (error) {
    if (error.errcode === ERR.NO_GATEWAY) throw new NoGatewayError(`lock ${lockId} is not connected to a gateway (${ERR.NO_GATEWAY})`);
    let exists;
    try { exists = await tt.passcodeExists(lockId, ref); } catch { throw error; } // cannot verify → keep original failure, retry later
    if (!exists) return { deleted: true, alreadyGone: true };
    throw error;
  }
}

const mapLock = l => ({
  lockId: l.lockId, lockAlias: l.lockAlias || l.lockName, electricQuantity: l.electricQuantity,
  hasGateway: l.hasGateway ? 1 : 0, groupId: l.groupId, groupName: l.groupName, cyclic: false,
});

/**
 * @param tt           TTLock client (ttlock.js)
 * @param opts.label   shown in status()
 * @param opts.cacheMs lock list cache — every API request needs the fleet,
 *                     and TTLock rate-limits (errcode 30006)
 * @param opts.onAuthFailure called when TTLock rejects the account's token
 */
function createCloudVendor(tt, { label = 'TTLock cloud', region = 'eu', cacheMs = 60e3, onAuthFailure = null, now = () => Date.now() } = {}) {
  let cache = null;
  const guard = async fn => {
    try {
      return await fn();
    } catch (error) {
      if (error && (TOKEN_ERRORS.has(error.errcode) || error.errcode === ERR.INVALID_REFRESH || error.reason === 'needs_reconnect')) {
        if (onAuthFailure) await onAuthFailure(error);
        throw new VendorUnavailableError('TTLock rejected this account\'s authorization — an owner must reconnect the TTLock account', { reason: 'needs_reconnect', cause: error });
      }
      if (isTransient(error)) {
        throw new VendorUnavailableError(`TTLock is not reachable right now (${transientWhy(error)}); try again shortly`, { reason: 'unavailable', cause: error });
      }
      throw error;
    }
  };
  return {
    kind: 'ttlock',
    demo: false,
    status: () => ({ mode: `LIVE (${label})`, region }),
    async listLocks() {
      if (cache && now() - cache.at < cacheMs) return cache.locks.map(l => ({ ...l }));
      const locks = (await guard(() => tt.listAllLocks())).map(mapLock);
      cache = { at: now(), locks };
      return locks.map(l => ({ ...l }));
    },
    invalidate() { cache = null; },
    unlock: lockId => guard(() => tt.unlock(lockId)),
    async createPasscode({ lockId, name, startAt, endAt }) {
      return guard(() => tt.createPasscode({
        lockId, keyboardPwdName: name, keyboardPwdType: 3, startDate: Date.parse(startAt), endDate: Date.parse(endAt),
      }));
    },
    deletePasscode: (lockId, ref) => guard(() => deletePasscodeIdempotent(tt, lockId, ref)),
    async records(lockId) {
      const r = await guard(() => tt.records(Number(lockId), { pageSize: 100 }));
      return (r.list || []).map(x => ({ ...x, typeLabel: RECORD_TYPES[x.recordType] || `type ${x.recordType}` }));
    },
    async info() {
      return {
        active: 'ttlock', available: ['ttlock', 'demo'],
        capabilities: { listLocks: true, unlock: true, passcodes: true, records: true, recordsMaxDays: 180, gateways: true, cyclicVerified: false },
        health: { vendor: 'ttlock', ok: true, mode: label },
      };
    },
    mirror: null,
  };
}

module.exports = { createCloudVendor, deletePasscodeIdempotent, NoGatewayError, VendorUnavailableError, mapLock, isTransient };
