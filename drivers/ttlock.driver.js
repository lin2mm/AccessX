/**
 * TTLock driver —— 把现有 ttlock.js 客户端包进统一接口
 *
 * ⚠️ 诚实说明：底层 ttlock.js 的 14 个端点从未对真实 TTLock 云跑过
 *    （无开发者凭证）。端点路径和参数名符合官方文档，但首次上线
 *    预期需要小修（token 处理、错误码映射）。
 */
const { LockDriver, METHOD } = require('./base');
const { TTLock } = require('../ttlock');

/** TTLock recordType → 规范化 method。数字来自官方文档的记录类型表。 */
const RECORD_METHOD = {
  1: METHOD.APP, 4: METHOD.PASSCODE, 7: METHOD.CARD,
  8: METHOD.FINGERPRINT, 9: METHOD.MECHANICAL, 10: METHOD.REMOTE,
  11: METHOD.GATEWAY, 12: METHOD.FACE, 15: METHOD.PALM,
};

class TTLockDriver extends LockDriver {
  constructor(opts = {}) {
    super(opts);
    this.vendor = 'ttlock';
    this.client = new TTLock(opts);
    this.demo = this.client.demo;
  }

  capabilities() {
    return {
      listLocks: true, unlock: true, lock: true,
      passcodes: true, cards: true, fingerprints: true,
      records: true,
      // ★ 官方 API 文档原文："云端只保留半年内的操作记录"
      //   这是我们必须自建镜像的直接原因，也是一个可收费的功能层。
      recordsMaxDays: 180,
      gateways: true,
      // ★ 已逐条核对完整 API 目录：user/lock/ekey/passcode/gateway/IC卡/指纹/
      //   人脸/记录/分组/固件/无线键盘/遥控/门磁/NB-IoT/二维码/WiFi锁/掌静脉/
      //   电表/水表 —— 不存在任何 doorbell/camera/video/intercom 端点。
      video: false,
      // BLE 协议已被第三方逆向（service 0x1910 / write fff2 / notify fff4 /
      // 包头 7f5a / CRC8-MAXIM），技术上可行，但法律状态未定，默认关闭。
      offlineLocal: false,
      webhooks: false,
    };
  }

  normalizeLock(l = {}) {
    return {
      id: String(l.lockId ?? l.id ?? ''),
      name: l.lockAlias || l.lockName || 'Unnamed lock',
      vendor: 'ttlock',
      battery: l.electricQuantity ?? null,
      online: l.gatewayId ? true : null,
      gatewayId: l.gatewayId ?? null,
      model: l.lockVersion?.groupId ? `group ${l.lockVersion.groupId}` : (l.modelNum || null),
      raw: l,
    };
  }

  normalizeRecord(r = {}) {
    return {
      id: String(r.recordId ?? r.id ?? ''),
      lockId: String(r.lockId ?? ''),
      at: r.lockDate ?? r.date ?? null,
      userId: r.username ?? null,
      userName: r.username ?? null,
      method: RECORD_METHOD[r.recordType] || METHOD.UNKNOWN,
      success: r.success === 1 || r.success === undefined,
      reason: null,   // TTLock 不返回拒绝原因 —— 这正是 Axess 的差异点
      raw: r,
    };
  }

  async listLocks() {
    const j = await this.client.call('/v3/lock/list', { pageNo: 1, pageSize: 100 });
    return (j.list || []).map((l) => this.normalizeLock(l));
  }

  async getLock(id) {
    const j = await this.client.call('/v3/lock/detail', { lockId: id });
    return this.normalizeLock(j);
  }

  async unlock(id) {
    const j = await this.client.call('/v3/lock/unlock', { lockId: id }, 'POST');
    return { ok: !j.errcode, raw: j };
  }

  async lockDoor(id) {
    const j = await this.client.call('/v3/lock/lock', { lockId: id }, 'POST');
    return { ok: !j.errcode, raw: j };
  }

  async listRecords(id, { startDate, endDate, pageNo = 1, pageSize = 100 } = {}) {
    const j = await this.client.call('/v3/lockRecord/list', {
      lockId: id, startDate, endDate, pageNo, pageSize,
    });
    return (j.list || []).map((r) => this.normalizeRecord(r));
  }

  async listPasscodes(id) {
    const j = await this.client.call('/v3/lock/listKeyboardPwd', {
      lockId: id, pageNo: 1, pageSize: 100,
    });
    return (j.list || []).map((k) => ({
      id: String(k.keyboardPwdId), lockId: String(id), code: k.keyboardPwd,
      name: k.keyboardPwdName, type: k.keyboardPwdType,
      startAt: k.startDate, endAt: k.endDate, raw: k,
    }));
  }

  async listGateways() {
    const j = await this.client.call('/v3/gateway/list', { pageNo: 1, pageSize: 100 });
    return (j.list || []).map((g) => ({
      id: String(g.gatewayId), name: g.gatewayName,
      online: g.isOnline === 1, lockCount: g.lockNum ?? null, raw: g,
    }));
  }

  async health() {
    if (this.demo) {
      return { vendor: 'ttlock', ok: true, mode: 'DEMO',
               note: 'No credentials set — running on demo fixtures. Cloud never contacted.' };
    }
    try {
      await this.client.getToken();
      return { vendor: 'ttlock', ok: true, mode: 'LIVE' };
    } catch (e) {
      return { vendor: 'ttlock', ok: false, mode: 'LIVE', error: String(e.message) };
    }
  }
}

module.exports = { TTLockDriver };
