/**
 * Demo driver —— 完全不依赖任何厂商，用本地夹具跑
 *
 * 存在的意义不只是开发方便：
 *   给集成商做演示时，你不需要 TTLock 凭证、不需要网络、不需要真锁。
 *   打开笔记本就能演示"为什么这个人被拒"。
 */
const { LockDriver, METHOD } = require('./base');

const LOCKS = [
  { id: '9001', name: 'Main Entrance',    battery: 82, online: true,  gatewayId: 'gw-1' },
  { id: '9002', name: 'Server Room',      battery: 91, online: true,  gatewayId: 'gw-1' },
  { id: '9003', name: 'Warehouse Side',   battery: 44, online: true,  gatewayId: 'gw-2' },
  { id: '9004', name: 'Office Floor 2',   battery: 67, online: true,  gatewayId: 'gw-1' },
  { id: '9005', name: 'Cleaner Cupboard', battery: 15, online: false, gatewayId: null  },
  { id: '9006', name: 'Loading Bay',      battery: 73, online: true,  gatewayId: 'gw-2' },
  { id: '9007', name: 'Roof Access',      battery: 58, online: true,  gatewayId: 'gw-2' },
];

class DemoDriver extends LockDriver {
  constructor(opts = {}) { super(opts); this.vendor = 'demo'; }

  capabilities() {
    return {
      listLocks: true, unlock: true, lock: true,
      passcodes: true, cards: false, fingerprints: false,
      records: true,
      recordsMaxDays: 3650,   // demo 不设限，用来展示"镜像之后能查多久"
      gateways: true, video: false, offlineLocal: true, webhooks: true,
    };
  }

  async listLocks() {
    return LOCKS.map((l) => ({ ...l, vendor: 'demo', model: 'DEMO-1', raw: l }));
  }
  async getLock(id) {
    return (await this.listLocks()).find((l) => l.id === String(id)) || null;
  }
  async unlock(id) { return { ok: true, raw: { demo: true, lockId: id } }; }
  async lockDoor(id) { return { ok: true, raw: { demo: true, lockId: id } }; }

  async listRecords(id) {
    const now = Date.now();
    return [
      { id: 'r1', lockId: String(id), at: now - 36e5,  userId: 'u3', userName: 'Dev Patel',
        method: METHOD.APP, success: true, reason: null, raw: {} },
      { id: 'r2', lockId: String(id), at: now - 72e5,  userId: 'u1', userName: 'Sarah Kim',
        method: METHOD.PASSCODE, success: false, reason: 'outside permitted hours', raw: {} },
    ];
  }
  async listPasscodes(id) {
    return [{ id: 'p1', lockId: String(id), code: '******', name: 'Contractor week 34',
              type: 'temporary', startAt: Date.now(), endAt: Date.now() + 6048e5, raw: {} }];
  }
  async listGateways() {
    return [
      { id: 'gw-1', name: 'Gateway — Reception', online: true, lockCount: 3, raw: {} },
      { id: 'gw-2', name: 'Gateway — Warehouse', online: true, lockCount: 3, raw: {} },
    ];
  }
  async health() {
    return { vendor: 'demo', ok: true, mode: 'DEMO', note: 'Local fixtures. No network required.' };
  }
}

module.exports = { DemoDriver };
