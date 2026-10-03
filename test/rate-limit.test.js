const test = require('node:test');
const assert = require('node:assert/strict');
const { ipKey, memoryLimiter, createLimiters, allow, LIMITS } = require('../rate-limit-core');
const { boot } = require('../support/boot');

test('ipKey: IPv4 as is, IPv6 grouped by /64, mapped IPv4 unwrapped', () => {
  assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('2001:db8:abcd:12:1::7'), '2001:db8:abcd:12::/64');
  assert.equal(ipKey('2001:0db8:abcd:0012:ffff:ffff:ffff:ffff'), '2001:db8:abcd:12::/64', 'same /64, same bucket');
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey(''), 'unknown');
});

test('memoryLimiter: fixed window per key, resets after the period', async () => {
  let t = 0;
  const l = memoryLimiter({ limit: 3, periodSec: 60 }, { now: () => t });
  const run = async (key) => (await l.limit({ key })).success;
  assert.deepEqual([await run('a'), await run('a'), await run('a'), await run('a')], [true, true, true, false]);
  assert.equal(await run('b'), true, 'other keys unaffected');
  t = 60_000;
  assert.equal(await run('a'), true, 'new window');
  const small = memoryLimiter({ limit: 1, periodSec: 60 }, { now: () => t, maxKeys: 2 });
  for (const k of ['x', 'y', 'z']) assert.equal((await small.limit({ key: k })).success, true, 'bounded memory evicts, never blocks new keys');
});

test('createLimiters uses the Workers binding when configured; allow() fails open', async () => {
  const seen = [];
  const binding = { limit: async ({ key }) => { seen.push(key); return { success: seen.length < 2 }; } };
  const limiterFor = createLimiters({ [LIMITS.visitorLink.binding]: binding });
  assert.equal(await allow(limiterFor, 'visitorLink', '2001:db8:1:2:3:4:5:6'), true);
  assert.equal(await allow(limiterFor, 'visitorLink', '2001:db8:1:2:9:9:9:9'), false);
  assert.deepEqual(seen, ['visitorLink:2001:db8:1:2::/64', 'visitorLink:2001:db8:1:2::/64']);
  assert.notEqual(limiterFor('notify'), binding, 'unbound kinds fall back to memory');
  const broken = createLimiters({ [LIMITS.notify.binding]: { limit: async () => { throw new Error('down'); } } });
  const err = console.error; console.error = () => {};
  try { assert.equal(await allow(broken, 'notify', '198.51.100.1'), true, 'a broken limiter never takes the endpoint down'); } finally { console.error = err; }
});

test('server: visitor links are limited per address; signed-in API unaffected', async (t) => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token', TTLOCK_NOTIFY_SECRET: 'rl-secret', RECONCILE_INTERVAL_MIN: '0' });
  t.after(() => api.close());
  const post = (path, ip) => fetch(`${api.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ token: 'x'.repeat(43) }) });
  const statuses = [];
  for (let i = 0; i < LIMITS.visitorLink.limit + 1; i++) statuses.push((await post(i % 2 ? '/api/visit-invite' : '/api/visit-checkout', '198.51.100.7')).status);
  assert.deepEqual([...new Set(statuses.slice(0, -1))], [404], 'unknown tokens: the usual 404 while under the limit');
  const last = await post('/api/visit-invite', '198.51.100.7');
  assert.equal(last.status, 429);
  assert.equal(last.headers.get('retry-after'), '60');
  assert.match((await last.json()).error, /Too many requests/);
  assert.equal((await post('/api/visit-invite', '198.51.100.8')).status, 404, 'another address is not affected');
  assert.equal((await api.call('GET', '/api/doors', { token: 'owner-token' })).status, 200);
  const notify = await fetch(`${api.base}/api/ttlock/notify/wrong`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7' }, body: 'lockId=1&records=[]' });
  assert.equal(notify.status, 404, 'the callback has its own, larger budget');
});
