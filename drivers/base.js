/**
 * LockDriver — 厂商无关的锁抽象接口
 * ====================================================================
 * 为什么存在：
 *   Axess 的价值在 acl.js（策略引擎）和记录镜像，不在"能调 TTLock"。
 *   如果 server.js 直接 import ttlock.js，那 TTLock 的商务谈判结果
 *   就等于公司的生死。加这一层之后，换厂商 = 换一个 driver 文件。
 *
 * 设计原则：
 *   1. 所有 driver 返回**同一套规范化字段**，上层永远不做厂商分支判断
 *   2. 能力用 capabilities() 声明，UI 按能力显示/隐藏，而不是硬编码
 *   3. 不支持的操作抛 UnsupportedOperation，不静默失败
 *
 * 规范化数据模型（所有 driver 必须转成这个形状）：
 *   Lock   { id, name, vendor, battery, online, gatewayId, model, raw }
 *   Record { id, lockId, at(ms), userId, userName, method, success, reason, raw }
 *   Code   { id, lockId, code, name, type, startAt, endAt, raw }
 */

class UnsupportedOperation extends Error {
  constructor(vendor, op) {
    super(`${vendor} driver does not support: ${op}`);
    this.name = 'UnsupportedOperation';
    this.vendor = vendor;
    this.op = op;
  }
}

/** 开门方式的规范化枚举 —— 各厂商编码不同，全部映射到这里 */
const METHOD = {
  APP: 'app',
  PASSCODE: 'passcode',
  CARD: 'card',
  FINGERPRINT: 'fingerprint',
  FACE: 'face',
  MECHANICAL: 'mechanical',
  REMOTE: 'remote',
  GATEWAY: 'gateway',
  PALM: 'palm',
  UNKNOWN: 'unknown',
};

class LockDriver {
  constructor(opts = {}) {
    this.opts = opts;
    this.vendor = 'base';
  }

  /**
   * 声明这个 driver 能做什么。UI 和 server 据此决定显示哪些功能。
   * 这样"TTLock 没有视频端点"变成一个数据事实，而不是散落在代码里的 if。
   */
  capabilities() {
    return {
      listLocks: false,
      unlock: false,
      lock: false,
      passcodes: false,
      cards: false,
      fingerprints: false,
      records: false,
      recordsMaxDays: 0,   // 0 = 不支持；TTLock 是 180（官方文档："云端只保留半年内的操作记录"）
      gateways: false,
      video: false,        // TTLock = false（已逐条核对完整 API 目录，无 doorbell/camera/video/intercom 端点）
      offlineLocal: false, // 能否绕过云直连（BLE）
      webhooks: false,
    };
  }

  async listLocks() { throw new UnsupportedOperation(this.vendor, 'listLocks'); }
  async getLock(id) { throw new UnsupportedOperation(this.vendor, 'getLock'); }
  async unlock(id) { throw new UnsupportedOperation(this.vendor, 'unlock'); }
  async lockDoor(id) { throw new UnsupportedOperation(this.vendor, 'lockDoor'); }
  async listRecords(id, opts) { throw new UnsupportedOperation(this.vendor, 'listRecords'); }
  async listPasscodes(id) { throw new UnsupportedOperation(this.vendor, 'listPasscodes'); }
  async createPasscode(id, o) { throw new UnsupportedOperation(this.vendor, 'createPasscode'); }
  async deletePasscode(id, c) { throw new UnsupportedOperation(this.vendor, 'deletePasscode'); }
  async listGateways() { throw new UnsupportedOperation(this.vendor, 'listGateways'); }

  /** 健康检查 —— 上线前用它确认凭证是否真的能用 */
  async health() {
    return { vendor: this.vendor, ok: false, mode: 'unimplemented' };
  }
}

module.exports = { LockDriver, UnsupportedOperation, METHOD };
