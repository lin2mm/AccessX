const assert = require('node:assert/strict');
const test = require('node:test');
const { boot } = require('../support/boot');

test('POST /api/evaluate interprets localTime in the door site time zone', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  // Sarah (Office Staff) at Main Entrance (Bristol), Wednesday 08:30 BST.
  const res = await api.call('POST', '/api/evaluate', {
    token: 'owner-token',
    body: { userId: 'u1', lockId: 9001, localTime: '2026-07-01T08:30' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.timeZone, 'Europe/London');
  assert.equal(res.body.at, '2026-07-01T07:30:00.000Z');
  assert.equal(res.body.result.allowed, true);
  assert.match(res.body.localTime, /08:30 Europe\/London/);
});

test('POST /api/evaluate rejects invalid dates', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const res = await api.call('POST', '/api/evaluate', {
    token: 'owner-token', body: { userId: 'u1', lockId: 9001, localTime: 'nope' },
  });
  assert.equal(res.status, 400);
});
