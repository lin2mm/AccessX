/**
 * Demo lock vendor — simulated fleet, no network, no physical locks.
 * Shared by server (no TTLock credentials) and the Cloudflare Worker.
 * Vendor interface (see vendor-ttlock.js for the live implementation):
 *   listLocks() unlock(id) createPasscode(o) deletePasscode(id, ref)
 *   records(id) info() status() mirror?
 */
const DEMO_LOCKS = [
  { lockId: 9001, lockAlias: 'Main Entrance', electricQuantity: 78, hasGateway: 1, groupName: 'Riverside Office', cyclic: true },
  { lockId: 9002, lockAlias: 'Server Room', electricQuantity: 91, hasGateway: 1, groupName: 'Riverside Office', cyclic: true },
  { lockId: 9003, lockAlias: 'Warehouse Side Door', electricQuantity: 42, hasGateway: 1, groupName: 'Riverside Office', cyclic: true },
  { lockId: 9004, lockAlias: 'Cleaner Cupboard', electricQuantity: 15, hasGateway: 0, groupName: 'Riverside Office', cyclic: false },
  { lockId: 9101, lockAlias: 'Gym Front Door', electricQuantity: 66, hasGateway: 1, groupName: 'Northgate Gym', cyclic: true },
  { lockId: 9102, lockAlias: 'Gym Staff Office', electricQuantity: 88, hasGateway: 1, groupName: 'Northgate Gym', cyclic: false },
  { lockId: 9201, lockAlias: 'Storage Block A Gate', electricQuantity: 55, hasGateway: 1, groupName: 'Selfstore Depot', cyclic: true },
];

const RECORD_TYPES = {
  1: 'App unlock', 4: 'Passcode unlock', 7: 'IC card unlock', 8: 'Fingerprint unlock',
  9: 'Wireless keypad', 10: 'Auto lock', 11: 'App lock', 12: 'Gateway unlock',
  46: 'Remote unlock', 47: 'Remote lock', 55: 'Remote control (fob)',
  '-5': 'Face unlock', '-4': 'QR code unlock', 123: 'Network exception',
};

function createDemoVendor({ mirror = null, locks = DEMO_LOCKS } = {}) {
  return {
    kind: 'demo',
    demo: true,
    status: () => ({ mode: 'DEMO (simulated locks; no physical lock operations)', region: 'demo' }),
    async listLocks() { return locks.map(lock => ({ ...lock })); },
    async unlock() { return { simulated: true }; },
    async createPasscode() {
      return { keyboardPwd: String(Math.floor(100000 + Math.random() * 899999)), keyboardPwdId: Date.now() };
    },
    async deletePasscode() { return { simulated: true }; },
    async records(lockId) {
      const types = [1, 4, 7, 8, 12, 55];
      const people = ['Sarah Kelly', 'Dev Patel', 'CleanCo Ltd', 'Tom Nguyen'];
      return Array.from({ length: 25 }, (_, index) => {
        const recordType = types[index % types.length];
        return {
          recordId: 1e6 + index, lockId: Number(lockId), recordType, typeLabel: RECORD_TYPES[recordType],
          success: index % 11 === 0 ? 0 : 1, username: people[index % people.length], lockDate: Date.now() - index * 3.4e6,
        };
      });
    },
    async info() {
      return {
        active: 'demo',
        available: ['demo'],
        capabilities: {
          listLocks: true, unlock: true, lock: true, passcodes: true, cards: false, fingerprints: false,
          records: true, recordsMaxDays: 3650, gateways: true, video: false, offlineLocal: true, webhooks: true,
        },
        health: { vendor: 'demo', ok: true, mode: 'DEMO', note: 'Simulated data. No physical lock operations.' },
      };
    },
    mirror,
  };
}

/** Read-only mirror over a { records, lastSync } document (Worker demo). */
function staticMirror(doc) {
  const records = (doc && doc.records) || [];
  return {
    async sync() { const e = new Error('Vendor sync is unavailable in the hosted demo.'); e.status = 501; throw e; },
    async coverage() {
      const cutoff = Date.now() - 180 * 864e5;
      const beyond = records.filter(r => (r.at || 0) < cutoff).length;
      return {
        total: records.length, beyondVendorRetention: beyond, vendorRetentionDays: 180,
        vendorRetentionSource: 'TTLock Open Platform docs: "云端只保留半年内的操作记录"',
        lastSync: doc ? doc.lastSync : null,
        note: beyond ? `${beyond} records exist only in your mirror — the vendor cloud has dropped them.`
          : 'No records older than the vendor retention window yet. Value accrues over time.',
      };
    },
    async query({ lockId = null, from = null, to = null, limit = 500 } = {}) {
      let result = records;
      if (lockId) result = result.filter(r => String(r.lockId) === String(lockId));
      if (from) result = result.filter(r => (r.at || 0) >= from);
      if (to) result = result.filter(r => (r.at || 0) <= to);
      return result.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, Math.min(limit || 500, 1000));
    },
  };
}

module.exports = { createDemoVendor, staticMirror, DEMO_LOCKS, RECORD_TYPES };
