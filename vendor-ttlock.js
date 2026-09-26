/**
 * Live TTLock vendor (server only). Wraps ttlock.js in the vendor interface.
 * Capability note: whether a lock supports cyclic (weekly) credentials is
 * model-dependent. Until it is verified per model it is reported as
 * false, so the policy compiler stays conservative.
 */
const { TTLock, RECORD_TYPES } = require('./ttlock');
const { getDriver, availableVendors } = require('./drivers');
const mirror = require('./mirror');

function createTTLockVendor(tt = new TTLock()) {
  return {
    kind: 'ttlock',
    demo: false,
    status: () => ({ mode: 'LIVE (TTLock cloud)', region: process.env.TTLOCK_REGION || 'eu' }),
    async listLocks() {
      const r = await tt.listLocks(1, 200);
      return (r.list || []).map(l => ({
        lockId: l.lockId, lockAlias: l.lockAlias, electricQuantity: l.electricQuantity,
        hasGateway: l.hasGateway, groupName: l.groupName, cyclic: false,
      }));
    },
    unlock: lockId => tt.unlock(lockId),
    async createPasscode({ lockId, name, startAt, endAt }) {
      return tt.createPasscode({
        lockId, keyboardPwdName: name, keyboardPwdType: 3, startDate: Date.parse(startAt), endDate: Date.parse(endAt),
      });
    },
    deletePasscode: (lockId, ref) => tt.deletePasscode(lockId, ref),
    async records(lockId) {
      const r = await tt.records(Number(lockId), { pageSize: 100 });
      return (r.list || []).map(x => ({ ...x, typeLabel: RECORD_TYPES[x.recordType] || `type ${x.recordType}` }));
    },
    async info() {
      const d = getDriver();
      return { active: d.vendor, available: availableVendors(), capabilities: d.capabilities(), health: await d.health() };
    },
    mirror: {
      sync: body => mirror.sync(getDriver(), body || {}),
      coverage: async () => mirror.coverage(),
      query: async params => mirror.query(params),
    },
  };
}

/** File-backed mirror for the server in demo mode (same behaviour as before). */
function fileMirror() {
  return {
    sync: body => mirror.sync(getDriver(), body || {}),
    coverage: async () => mirror.coverage(),
    query: async params => mirror.query(params),
  };
}

module.exports = { createTTLockVendor, fileMirror };
