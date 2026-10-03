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

/**
 * Codes someone left on the demo locks outside AccessX (the passcode sweep
 * finds them): an old permanent code, a contractor's live code, an expired one.
 */
const DEMO_ORPHANS = [
  { lockId: 9001, ref: 'demo-501', name: 'Old cleaner code', type: 'permanent', startAt: '2025-03-03T08:00:00.000Z', endAt: null, createdBy: 'facilities@acme.co.uk', createdAt: '2025-03-03T07:55:00.000Z' },
  { lockId: 9003, ref: 'demo-502', name: 'Contractor', type: 'period', startDays: -10, endDays: 20, createdBy: 'facilities@acme.co.uk' },
  { lockId: 9002, ref: 'demo-503', name: 'Temp access', type: 'period', startAt: '2026-01-05T09:00:00.000Z', endAt: '2026-01-30T18:00:00.000Z', createdBy: 'facilities@acme.co.uk', createdAt: '2026-01-05T08:58:00.000Z' },
];
const demoDeleted = new Set(); // `${lockId}:${ref}` removed in this process
/** Every call that would change a lock (unlock, add or delete a code), for the scope gate (test/scope.fuzz.test.js). */
const demoCalls = [];
const noteCall = (op, lockId) => { if (demoCalls.length < 20000) demoCalls.push({ op, lockId: Number(lockId) }); };

function createDemoVendor({ mirror = null, locks = DEMO_LOCKS } = {}) {
  return {
    kind: 'demo',
    demo: true,
    status: () => ({ mode: 'DEMO (simulated locks; no physical lock operations)', region: 'demo' }),
    async listLocks() { return locks.map(lock => ({ ...lock })); },
    async unlock(lockId) { noteCall('unlock', lockId); return { simulated: true }; },
    async createPasscode({ lockId } = {}) {
      noteCall('createPasscode', lockId);
      return { keyboardPwd: String(Math.floor(100000 + Math.random() * 899999)), keyboardPwdId: Date.now() };
    },
    async deletePasscode(lockId, ref) { noteCall('deletePasscode', lockId); demoDeleted.add(`${Number(lockId)}:${ref}`); return { simulated: true }; },
    /**
     * Simulated: the lock holds the codes the registry expects (`expected`,
     * passed by the sweep) plus DEMO_ORPHANS, minus what was deleted here.
     */
    async listPasscodes(lockId, { expected = [] } = {}) {
      const day = 864e5; const midnight = Math.floor(Date.now() / day) * day;
      const orphans = DEMO_ORPHANS.filter(o => o.lockId === Number(lockId)).map(({ lockId: _l, startDays, endDays, ...o }) => (startDays === undefined ? o
        : { ...o, startAt: new Date(midnight + startDays * day).toISOString(), endAt: new Date(midnight + endDays * day).toISOString(), createdAt: new Date(midnight + startDays * day).toISOString() }));
      const known = expected.map(e => ({ ref: String(e.ref), name: e.name || 'AccessX', type: 'period', startAt: e.startAt || null, endAt: e.endAt || null, createdBy: 'accessx', createdAt: e.issuedAt || null }));
      return [...known, ...orphans].filter(c => !demoDeleted.has(`${Number(lockId)}:${c.ref}`));
    },
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

module.exports = { createDemoVendor, staticMirror, DEMO_LOCKS, DEMO_ORPHANS, RECORD_TYPES, demoCalls };
