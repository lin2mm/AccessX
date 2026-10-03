/**
 * store/shared-wait.js (R20): on Workers, a request waiting for another
 * request's in-flight work polls a flag instead of awaiting that request's promise
 * (awaiting it throws "Cannot perform I/O on behalf of a different request").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { share, awaitShared, SharedWaitTimeout } = require('../store/shared-wait');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('Workers mode: the waiter gets the value by polling, never by joining the promise', async () => {
  const d = deferred();
  const p = share(d.promise);
  let polls = 0;
  const sleep = async () => { polls += 1; if (polls === 3) d.resolve({ rows: 7 }); await new Promise(r => setImmediate(r)); };
  const origThen = p.then;
  let joined = 0;
  p.then = function (...a) { joined += 1; return origThen.apply(this, a); }; // any await/then after share() would count here
  assert.deepEqual(await awaitShared(p, { workers: true, sleep }), { rows: 7 });
  assert.equal(joined, 0, 'the waiter never attached to the other request\'s promise');
  assert.ok(polls >= 3);
});

test('Workers mode: a failure is passed on; a stuck request times out so the caller can do the work itself', async () => {
  const bad = share(Promise.reject(new Error('D1 down')));
  await assert.rejects(awaitShared(bad, { workers: true, sleep: () => new Promise(r => setImmediate(r)) }), /D1 down/);
  const stuck = share(new Promise(() => {}));
  await assert.rejects(awaitShared(stuck, { workers: true, pollMs: 5, maxMs: 20, sleep: () => Promise.resolve() }), e => e instanceof SharedWaitTimeout);
});

test('Node mode, or a promise that was not shared: plain await', async () => {
  assert.equal(await awaitShared(share(Promise.resolve(3)), { workers: false }), 3);
  assert.equal(await awaitShared(Promise.resolve(4), { workers: true }), 4);
});

test('runtime detection: Workers mode is on exactly under workerd (R22)', () => {
  // The smoke test cannot reproduce the R20 bug with a small tenant, so pin the switch itself:
  // if detection ever says "not Workers" on Workers, every waiter awaits foreign I/O again.
  const vm = require('node:vm');
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../store/shared-wait'), 'utf8');
  const load = navigator => {
    const mod = { exports: {} };
    vm.runInNewContext(src, { module: mod, exports: mod.exports, navigator, setTimeout, WeakMap, Error, Promise });
    return mod.exports.ON_WORKERS;
  };
  assert.equal(load({ userAgent: 'Cloudflare-Workers' }), true, 'workerd reports navigator.userAgent === "Cloudflare-Workers"');
  assert.equal(load(undefined), false);
  assert.equal(load({ userAgent: 'Node.js/22' }), false);
  assert.equal(require('../store/shared-wait').ON_WORKERS, false, 'plain Node');
});
