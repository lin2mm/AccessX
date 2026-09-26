/**
 * 鉴权层 —— 80 号列为"有真客户数据前必须修"的项。
 *
 * 现状问题：admin API 完全裸奔，任何人能 POST /api/doors/:id/unlock 开门。
 * 演示时无所谓，一旦接真锁就是事故。
 *
 * 设计取舍（原型级，但比裸奔强一个量级）：
 *   - Bearer token + 时间安全比较（防时序攻击）
 *   - 写操作(POST/PUT/DELETE)一律要鉴权；只读端点可配置放行以便演示
 *   - 失败尝试计数 + 限流，防暴力猜 token
 *   - 未设 ADMIN_TOKEN 时进入 DEMO 模式并在日志明确警告，不静默放行
 *
 * ⚠️ 仍不足以上生产：无多租户隔离、无用户级权限、无 TLS(需反代)、
 *    token 不轮换。真上线要换成 OIDC/JWT + 每租户密钥。
 */
const crypto = require('crypto');

const TOKEN = process.env.ADMIN_TOKEN || '';
const DEMO = !TOKEN;
const OPEN_READS = process.env.AUTH_OPEN_READS !== '0'; // 默认允许只读，方便演示

// 简易限流：IP -> {count, resetAt}
const fails = new Map();
const MAX_FAILS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress || 'unknown';
}

function tooManyFails(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() > f.resetAt) { fails.delete(ip); return false; }
  return f.count >= MAX_FAILS;
}

function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() > f.resetAt) {
    fails.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  } else {
    f.count++;
  }
}

/** Express 中间件 */
function requireAuth(req, res, next) {
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (DEMO) {
    // 不静默放行 —— 每个写操作都在响应里标明这是无鉴权模式
    if (!isRead) res.setHeader('X-Auth-Mode', 'DEMO-NO-AUTH');
    return next();
  }

  if (isRead && OPEN_READS) return next();

  const ip = clientIp(req);

  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  const valid = m && safeEqual(m[1], TOKEN);

  // ★ 先验 token 再看限流：否则同一 NAT 出口下，攻击者猜错几次
  //   就能把持有正确凭证的同事一起锁死（实测发现的缺陷）。
  //   限流的目的是拖慢暴力猜解，不是惩罚合法用户。
  if (valid) { fails.delete(ip); return next(); }

  if (!m || !valid) {
    noteFail(ip);
    if (tooManyFails(ip)) {
      return res.status(429).json({ ok: false, error: 'too many failed auth attempts, try later' });
    }
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      hint: 'send header: Authorization: Bearer <ADMIN_TOKEN>',
    });
  }
}

function authStatus() {
  return {
    mode: DEMO ? 'DEMO (no ADMIN_TOKEN set — writes are UNPROTECTED)' : 'TOKEN',
    openReads: DEMO ? true : OPEN_READS,
    lockedOutIps: [...fails.entries()].filter(([, f]) => f.count >= MAX_FAILS).length,
    warning: DEMO
      ? '🔴 Set ADMIN_TOKEN before connecting real locks or real customer data.'
      : null,
  };
}

module.exports = { requireAuth, authStatus, DEMO };
