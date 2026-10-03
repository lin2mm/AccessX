// R20: npm run nuki:check against the fake Nuki cloud (support/fake-nuki.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { nukiFixture } = require('../support/fake-nuki');

const run = (env, args) => new Promise(resolve => {
  execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'nuki-check.js'), ...args], { env: { ...process.env, ...env }, timeout: 60000 }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout }));
});

test('nuki:check: read-only report, then a code created, confirmed and deleted through the production path', async () => {
  const cloud = nukiFixture();
  const base = await cloud.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuki-check-'));
  try {
    const out = path.join(dir, 'r.json');
    const r = await run({ NUKI_API_TOKEN: 'nuki-river-token', NUKI_API_BASE: base }, ['--write', '9001', '--json', out]);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    const byName = n => report.checks.find(c => c.name === n);
    assert.equal(r.code, 1, 'the fixture has an offline lock and one without keypad');
    assert.equal(report.locks.length, 4);
    assert.equal(byName('Cleaner Cupboard (9004): online').ok, false);
    assert.equal(byName('Server Room (9002): keypad paired').ok, false);
    assert.equal(byName('Main Entrance (9001): online').ok, true);
    const created = byName('create a 1-hour keypad code and see it listed');
    assert.equal(created.ok, true, created.detail);
    assert.equal(byName('delete it and see it gone').ok, true);
    const digits = created.detail.match(/code (\d{6})/)[1];
    assert.ok(!r.stdout.includes('nuki-river-token'), 'never prints the token');
    assert.equal([...cloud.state.locks[9001].auths.values()].filter(a => String(a.code) === digits).length, 0, 'the test code is gone');

    // A read-only token: listing works, codes cannot be read -> fails loudly.
    const ro = await run({ NUKI_API_TOKEN: 'nuki-readonly-token', NUKI_API_BASE: base }, []);
    assert.equal(ro.code, 1);
    assert.match(ro.stdout, /FAIL {2}Gym Front Door \(9101\): codes readable \(scope smartlock\.auth\)/);
    // A wrong token.
    const bad = await run({ NUKI_API_TOKEN: 'not-a-real-token-000000', NUKI_API_BASE: base }, []);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /FAIL {2}token accepted, locks listed — .*401/);
  } finally { await cloud.close(); }
});
