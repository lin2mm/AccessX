const crypto = require('crypto');
const rbac = require('./rbac-core');

const MAX_FAILS = 8;
const WINDOW_MS = 10 * 60 * 1000;

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function clientIp(req) {
  // NOTE: x-forwarded-for is client-controlled unless a trusted proxy
  // overwrites it. Behind a proxy, configure Express "trust proxy" instead.
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown';
}

function requestPath(req) {
  return String(req.originalUrl || (req.baseUrl || '') + (req.path || '') || req.url || '').split('?')[0];
}

function createAuth({
  token = process.env.ADMIN_TOKEN || '',
  openReads = process.env.AUTH_OPEN_READS === '1',
  operators = process.env.OPERATORS || '',
  getDb = () => ({}),
  maxFails = MAX_FAILS,
  windowMs = WINDOW_MS,
} = {}) {
  const directory = rbac.parseOperators(operators, token ? sha256(token) : '');
  const failures = new Map();

  function noteFail(ip) {
    const entry = failures.get(ip);
    if (!entry || Date.now() > entry.resetAt) {
      failures.set(ip, { count: 1, resetAt: Date.now() + windowMs });
    } else {
      entry.count++;
    }
    return failures.get(ip).count;
  }

  return function requireAuth(req, res, next) {
    const perm = rbac.requiredPermission(req.method, requestPath(req));
    if (perm === rbac.PUBLIC) return next();

    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      if (openReads && rbac.hasPermission(null, rbac.ANONYMOUS, perm)) {
        req.operator = rbac.ANONYMOUS;
        return next();
      }
      if (!directory.length) {
        const isRead = req.method === 'GET' || req.method === 'HEAD';
        return res.status(503).json({
          ok: false,
          error: isRead
            ? 'API access is disabled until ADMIN_TOKEN or OPERATORS is configured.'
            : 'Writes are disabled until ADMIN_TOKEN or OPERATORS is configured.',
        });
      }
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const ip = clientIp(req);
    const failed = failures.get(ip);
    if (failed && Date.now() > failed.resetAt) failures.delete(ip);

    const operator = rbac.findOperator(directory, sha256(match[1].trim()));
    if (!operator) {
      if (noteFail(ip) >= maxFails) {
        return res.status(429).json({ ok: false, error: 'too many failed auth attempts, try later' });
      }
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    failures.delete(ip);
    req.operator = operator;

    if (!rbac.hasPermission(getDb(), operator, perm)) {
      return res.status(403).json({ ok: false, error: 'forbidden', required: perm });
    }
    return next();
  };
}

function authStatus({
  token = process.env.ADMIN_TOKEN || '',
  openReads = process.env.AUTH_OPEN_READS === '1',
  operators = process.env.OPERATORS || '',
} = {}) {
  let count = 0;
  try { count = rbac.parseOperators(operators, token ? 'x'.repeat(64) : '').length; } catch { count = 0; }
  return {
    mode: count ? 'TOKEN' : openReads ? 'DEMO-READ-ONLY' : 'LOCKED',
    tokenConfigured: Boolean(token),
    operatorsConfigured: count,
    openReads,
    writesRequireToken: true,
  };
}

module.exports = { createAuth, authStatus, sha256 };
