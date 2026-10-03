'use strict';
/**
 * Waiting for work another request started (single-flight), safely on Workers (R20).
 *
 * Cloudflare Workers tie I/O to the request that started it. If request B awaits
 * a promise that request A's I/O will settle, B's continuation runs in A's
 * context, and B's next D1 query or fetch throws "Cannot perform I/O on behalf
 * of a different request" (the R20 load test hit this: ~45 % 500s when reads and
 * writes overlapped). So on Workers a waiter never awaits the shared promise: it
 * polls a flag with its own timers, and its continuations stay in its own request.
 * On Node, awaiting the promise directly is fine and faster.
 *
 *   inflight = share(doWork());          // the request that does the work
 *   await awaitShared(inflight);         // anyone else
 */
const ON_WORKERS = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
const states = new WeakMap();

class SharedWaitTimeout extends Error {
  constructor(ms) { super(`gave up waiting ${ms} ms for another request's work`); this.name = 'SharedWaitTimeout'; }
}

/** Mark `promise` as shareable; returns it unchanged. The handlers only set flags (no I/O). */
function share(promise) {
  const s = { settled: false, ok: false, value: undefined, error: undefined };
  states.set(promise, s);
  promise.then(v => { s.settled = true; s.ok = true; s.value = v; }, e => { s.settled = true; s.error = e; });
  return promise;
}

/**
 * Settle like `promise` without joining its I/O context. `workers` is for tests.
 * A request that was cancelled may never settle its work: after `maxMs` this
 * throws SharedWaitTimeout, and the caller should do the work itself.
 */
async function awaitShared(promise, { workers = ON_WORKERS, pollMs = 5, maxMs = 10000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const s = states.get(promise);
  if (!workers || !s) return promise;
  let waited = 0;
  while (!s.settled) {
    if (waited >= maxMs) throw new SharedWaitTimeout(maxMs);
    await sleep(pollMs);
    waited += pollMs;
  }
  if (!s.ok) throw s.error;
  return s.value;
}

module.exports = { share, awaitShared, SharedWaitTimeout, ON_WORKERS };
