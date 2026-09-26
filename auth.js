const crypto = require('crypto');

const TOKEN = process.env.ADMIN_TOKEN || '';
const OPEN_READS = process.env.AUTH_OPEN_READS === '1';
const MAX_FAILS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown';
}

function createAuth({ token = TOKEN, openReads = OPEN_READS, maxFails = MAX_FAILS, windowMs = WINDOW_MS } = {}) {
  const failures = new Map();

  function noteFail(ip) {
    const entry = failures.get(ip);
    if (!entry || Date.now() > entry.resetAt) {
      failures.set(ip, { count: 1, resetAt: Date.now() + windowMs });
    } else {
      entry.count++;
    }
  }

  return function requireAuth(req, res, next) {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isRead && openReads) return next();

    if (!token) {
      return res.status(503).json({
        ok: false,
        error: isRead
          ? 'API access is disabled until ADMIN_TOKEN is configured.'
          : 'Writes are disabled until ADMIN_TOKEN is configured.',
      });
    }

    const ip = clientIp(req);
    const failed = failures.get(ip);
    if (failed && Date.now() > failed.resetAt) failures.delete(ip);

    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match && safeEqual(match[1], token)) {
      failures.delete(ip);
      return next();
    }

    noteFail(ip);
    if (failures.get(ip).count >= maxFails) {
      return res.status(429).json({ ok: false, error: 'too many failed auth attempts, try later' });
    }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  };
}

function authStatus({ token = TOKEN, openReads = OPEN_READS } = {}) {
  return {
    mode: token ? 'TOKEN' : openReads ? 'DEMO-READ-ONLY' : 'LOCKED',
    tokenConfigured: Boolean(token),
    openReads,
    writesRequireToken: true,
  };
}

module.exports = { createAuth, requireAuth: createAuth(), authStatus };
