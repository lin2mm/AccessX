const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { boot } = require('../support/boot');

test('audit log is append-only, chained, and migrates the legacy log', async t => {
  const api = await boot({ ADMIN_TOKEN: 'owner-token' });
  t.after(api.close);
  const owner = { token: 'owner-token' };

  const first = await api.call('GET', '/api/audit', owner);
  assert.equal(first.body.log[0].action, 'audit.migrated');

  for (let i = 0; i < 3; i++) await api.call('POST', '/api/doors/9001/unlock', { ...owner, body: {} });
  const verify = await api.call('GET', '/api/audit/verify', owner);
  assert.equal(verify.body.verification.ok, true);
  const head = verify.body.verification.head;
  assert.ok(head.seq >= 18);

  // nothing is ever dropped: pagination reaches seq 1
  const oldest = await api.call('GET', `/api/audit?before=3&limit=10`, owner);
  assert.deepEqual(oldest.body.log.map(e => e.seq), [2, 1]);

  // Tamper with the file on disk -> verification pinpoints the entry.
  const file = path.join(api.dataDir, 'audit.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const victim = JSON.parse(lines[5]);
  victim.actor = 'someone-else';
  lines[5] = JSON.stringify(victim);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const broken = await api.call('GET', '/api/audit/verify', owner);
  assert.equal(broken.body.verification.ok, false);
  assert.equal(broken.body.verification.brokenAt, victim.seq);
});
