/**
 * Per-tenant write queue: one write at a time per tenant, FIFO.
 *
 * Why: every write appends to the tenant's audit chain, and the chain head is
 * the tenant's version number (optimistic concurrency, store/repo.js). Under
 * a burst (an IdP's first SCIM sync of 2,000 people) parallel writers keep
 * invalidating each other, retries run out and requests fail with 409 — which
 * SCIM clients treat as final, parking a leaver's deactivation for a whole
 * provisioning cycle. Queuing writes per tenant removes the contention; reads
 * never queue.
 *
 * Node (server.js) uses one queue in-process. Cloudflare runs the same queue
 * inside a Durable Object per tenant (worker.js TenantWriter): a Durable
 * Object is a single instance worldwide, so writes are serialized across all
 * isolates and colos, not just within one.
 */
class QueueFullError extends Error {
  constructor(depth) { super(`too many writes queued for this tenant (${depth}), retry shortly`); this.status = 429; this.retryAfter = 2; }
}

function createTenantQueue({ maxDepth = 256 } = {}) {
  const tails = new Map();
  const depths = new Map();
  let processed = 0;
  let maxSeen = 0;

  async function run(key, fn) {
    if (key === null || key === undefined) return fn();
    const depth = depths.get(key) || 0;
    if (depth >= maxDepth) throw new QueueFullError(depth);
    depths.set(key, depth + 1);
    maxSeen = Math.max(maxSeen, depth + 1);
    const result = (tails.get(key) || Promise.resolve()).then(() => fn());
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    try {
      return await result;
    } finally {
      processed++;
      const left = depths.get(key) - 1;
      if (left) depths.set(key, left); else depths.delete(key);
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  const stats = () => ({ processed, maxDepthSeen: maxSeen, queued: Object.fromEntries(depths) });
  return { run, stats };
}

/** The api.handle() result for a full queue. */
function busyResponse(error, path = '') {
  const headers = { 'retry-after': String(error.retryAfter || 2) };
  if (String(path).startsWith('/scim/')) {
    return { status: 429, headers, contentType: 'application/scim+json',
      body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '429', detail: error.message } };
  }
  return { status: 429, headers, body: { ok: false, error: error.message } };
}

module.exports = { createTenantQueue, busyResponse, QueueFullError };
