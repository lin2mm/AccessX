'use strict';
/**
 * Brakes for the three unauthenticated endpoints: the TTLock record callback
 * and the visitor check-out / pre-registration links. They already fail
 * safely (unknown secret or token: 404; invites lock after 5 attempts); the
 * limit keeps a scanner from turning them into free load or a guessing oracle.
 *
 * On Cloudflare the Workers Rate Limiting binding does the counting (per
 * location, eventually consistent: a brake, not a quota). On Node, one
 * process, an exact fixed window in memory.
 */

const LIMITS = {
  // TTLock sends from a few servers; one busy office produces a burst of
  // records per door event. Generous per source address.
  notify: { limit: 600, periodSec: 60, binding: 'RL_NOTIFY' },
  // A visitor opens one link once or twice. Per address (IPv6: per /64).
  visitorLink: { limit: 20, periodSec: 60, binding: 'RL_PUBLIC' },
  // Stripe webhooks: signed, but a flood of bad signatures still costs an HMAC each.
  stripe: { limit: 600, periodSec: 60, binding: 'RL_NOTIFY' },
  // Self-service signup and its emailed link (R15). The daily caps per
  // address and in total are in signup-core (counted in the database).
  signup: { limit: 10, periodSec: 60, binding: 'RL_PUBLIC' },
  // Reception tablet and the phones scanning its code (R16): one office IP, a morning rush.
  // Per-kiosk walk-in caps are counted in the database.
  kiosk: { limit: 120, periodSec: 60, binding: 'RL_NOTIFY' },
};

/** Rate-limit key for an address: IPv4 as is; IPv6 by its /64 (one host gets a whole /64). */
function ipKey(ip) {
  const s = String(ip || '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!s.includes(':')) return s || 'unknown';
  const [head, tail] = s.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.slice(0, 4).map(g => (g || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Exact fixed-window limiter for one process. `now` injectable for tests. */
function memoryLimiter({ limit, periodSec }, { now = () => Date.now(), maxKeys = 50000 } = {}) {
  const windows = new Map();
  return {
    async limit({ key }) {
      const t = now();
      let w = windows.get(key);
      if (!w || t >= w.resetAt) {
        if (windows.size >= maxKeys) for (const [k, v] of windows) if (t >= v.resetAt) windows.delete(k);
        if (windows.size >= maxKeys) windows.delete(windows.keys().next().value);
        w = { count: 0, resetAt: t + periodSec * 1000 };
        windows.set(key, w);
      }
      w.count += 1;
      return { success: w.count <= limit };
    },
  };
}

/**
 * limiterFor(kind, env) -> { limit({key}) }: the Workers binding when it is
 * configured, else an in-memory window (Node; or a Worker without the binding,
 * where it is per isolate and only a weak brake).
 */
function createLimiters(env = {}, opts) {
  const made = {};
  return function limiterFor(kind) {
    const spec = LIMITS[kind];
    if (!spec) throw new Error(`unknown limit ${kind}`);
    const bound = env[spec.binding];
    if (bound && typeof bound.limit === 'function') return bound;
    return made[kind] || (made[kind] = memoryLimiter(spec, opts));
  };
}

/** true when the request may proceed. Never throws: a broken limiter must not take the endpoint down. */
async function allow(limiterFor, kind, ip) {
  try {
    const { success } = await limiterFor(kind).limit({ key: `${kind}:${ipKey(ip)}` });
    return success !== false;
  } catch (error) {
    console.error('rate limiter failed', error && error.message);
    return true;
  }
}

module.exports = { LIMITS, ipKey, memoryLimiter, createLimiters, allow };
