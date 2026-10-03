/**
 * Record mirror —— 把开门记录抄进自己的库
 * ====================================================================
 * 为什么这是产品而不是运维脚本：
 *
 *   TTLock 官方 API 文档原文："云端只保留半年内的操作记录"。
 *   超过 180 天，记录在厂商云里就没了。
 *
 *   而 RemoteLock 卖的正是 1 年 / 3 年的事件历史。
 *   也就是说：客户愿意为"记录能留多久"付钱，这是已被验证的付费点。
 *
 *   所以镜像同时是：
 *     1. 破除厂商限制的技术手段
 *     2. 一个可以直接标价的功能层（Free 180天 / Pro 3年 / 合规版 7年）
 *     3. 换厂商时的资产 —— 记录在你手里，不在 TTLock 手里
 *
 * 存储：JSON 文件（原型）。生产应换 Postgres / SQLite，见 honest notes。
 */
const fs = require('fs');
const path = require('path');

const SEED = path.join(__dirname, 'data', 'mirror.json');
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data', 'runtime');
const FILE = path.join(DIR, 'mirror.json');

const RETENTION = {
  free: 180,        // 与 TTLock 云一致 —— 免费层不提供额外价值
  pro: 1095,        // 3 年
  compliance: 2555, // 7 年
};

function load() {
  for (const file of [FILE, SEED]) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* try next */ }
  }
  return { records: [], lastSync: null, stats: {} };
}

function save(db) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
}

/** 记录去重键：同锁 + 同时间 + 同用户 视为同一条 */
function key(r) {
  return `${r.lockId}|${r.at}|${r.userId || ''}|${r.method || ''}`;
}

/**
 * 从 driver 拉取记录并合并进镜像。
 * 幂等：重复跑不会产生重复记录。
 */
async function sync(driver, { lockIds = null } = {}) {
  const db = load();
  const seen = new Set(db.records.map(key));
  let locks;
  try {
    locks = await driver.listLocks();
  } catch (e) {
    return { ok: false, error: `listLocks failed: ${e.message}` };
  }
  const targets = lockIds ? locks.filter((l) => lockIds.includes(l.id)) : locks;

  let added = 0, failed = 0;
  for (const l of targets) {
    try {
      const recs = await driver.listRecords(l.id, {});
      for (const r of recs) {
        if (seen.has(key(r))) continue;
        seen.add(key(r));
        db.records.push({ ...r, mirroredAt: Date.now(), lockName: l.name });
        added++;
      }
    } catch (e) {
      failed++;
    }
  }
  db.lastSync = Date.now();
  db.stats = {
    total: db.records.length,
    locks: targets.length,
    oldest: db.records.length ? Math.min(...db.records.map((r) => r.at || Infinity)) : null,
    newest: db.records.length ? Math.max(...db.records.map((r) => r.at || 0)) : null,
  };
  save(db);
  return { ok: true, added, failed, locksScanned: targets.length, stats: db.stats };
}

/** 查询镜像 —— 这是超出 180 天后唯一还能查到的地方 */
function query({ lockId = null, from = null, to = null, limit = 500 } = {}) {
  const db = load();
  let rs = db.records;
  if (lockId) rs = rs.filter((r) => String(r.lockId) === String(lockId));
  if (from) rs = rs.filter((r) => (r.at || 0) >= from);
  if (to) rs = rs.filter((r) => (r.at || 0) <= to);
  return rs.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

/** 按保留策略清理 */
function prune(tier = 'free') {
  const days = RETENTION[tier] ?? RETENTION.free;
  const cutoff = Date.now() - days * 864e5;
  const db = load();
  const before = db.records.length;
  db.records = db.records.filter((r) => (r.at || 0) >= cutoff);
  save(db);
  return { tier, days, removed: before - db.records.length, remaining: db.records.length };
}

/**
 * 镜像覆盖了 TTLock 云已经丢弃的多少记录 —— 这是给客户看的销售数字。
 */
function coverage() {
  const db = load();
  const cutoff = Date.now() - 180 * 864e5;
  const beyond = db.records.filter((r) => (r.at || 0) < cutoff);
  return {
    total: db.records.length,
    beyondVendorRetention: beyond.length,
    vendorRetentionDays: 180,
    vendorRetentionSource: 'TTLock Open Platform docs: "云端只保留半年内的操作记录"',
    lastSync: db.lastSync,
    note: beyond.length
      ? `${beyond.length} records exist only in your mirror — the vendor cloud has dropped them.`
      : 'No records older than the vendor retention window yet. Value accrues over time.',
  };
}

module.exports = { sync, query, prune, coverage, load, RETENTION };
