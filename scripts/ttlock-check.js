#!/usr/bin/env node
/**
 * Real-device check for a TTLock account — run it ON SITE, with the real
 * account, before promising anything to a customer.
 *
 *   TTLOCK_CLIENT_ID=… TTLOCK_CLIENT_SECRET=… TTLOCK_USER=… TTLOCK_PASS=… \
 *   SITE_TZ=Australia/Sydney node scripts/ttlock-check.js            # read-only
 *   … node scripts/ttlock-check.js --write 1234567                     # + create/delete a test code on lock 1234567
 *   … node scripts/ttlock-check.js --json report.json                  # also save the report
 *
 * Read-only mode: login, lock list (battery, gateway), lock clock vs.
 * server clock (needs a gateway; this is how you find out whether the
 * lock's clock follows daylight saving), passcode counts.
 *
 * --write <lockId>: creates a 1-hour period passcode named
 * "AccessX check", checks it is listed, deletes it with deleteType=2
 * (gateway) and checks it is gone. On a lock WITHOUT a gateway the delete
 * must fail with -2012 — then remove the code on site via the TTLock app
 * (Bluetooth) and note it. Type the code on the keypad before and after
 * the delete: the keypad is the only proof that counts.
 */
const { TTLock, ERR } = require('../ttlock');
const policy = require('../policy-core');

const args = process.argv.slice(2);
const writeLock = args.includes('--write') ? Number(args[args.indexOf('--write') + 1]) : null;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const tz = process.env.SITE_TZ || 'Australia/Sydney';

const report = { at: new Date().toISOString(), siteTimeZone: tz, checks: [], locks: [] };
const check = (name, ok, detail = '') => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const need = ['TTLOCK_CLIENT_ID', 'TTLOCK_CLIENT_SECRET', 'TTLOCK_USER', 'TTLOCK_PASS'].filter(k => !process.env[k]);
  if (need.length) { console.error(`missing env: ${need.join(', ')}`); process.exit(2); }
  const region = process.env.TTLOCK_REGION || 'eu';

  let tokens;
  try {
    tokens = await TTLock.login({
      region, apiBase: process.env.TTLOCK_API_BASE, clientId: process.env.TTLOCK_CLIENT_ID,
      clientSecret: process.env.TTLOCK_CLIENT_SECRET, username: process.env.TTLOCK_USER, password: process.env.TTLOCK_PASS,
    });
    check('login (password grant)', true, `uid=${tokens.uid} token expires ${new Date(tokens.expiresAt).toISOString().slice(0, 10)} scope=${tokens.scope || '?'}`);
    check('refresh token issued', Boolean(tokens.refreshToken), tokens.refreshToken ? '' : 'no refresh_token: the account must be reconnected every 90 days');
  } catch (e) {
    check('login (password grant)', false, e.message);
    return finish();
  }
  const tt = new TTLock({ region, apiBase: process.env.TTLOCK_API_BASE, clientId: process.env.TTLOCK_CLIENT_ID, tokenProvider: async () => tokens.accessToken });

  const locks = await tt.listAllLocks();
  check('lock list', locks.length > 0, `${locks.length} lock(s)`);
  for (const l of locks) {
    const row = { lockId: l.lockId, alias: l.lockAlias, battery: l.electricQuantity, gateway: Boolean(l.hasGateway) };
    if (l.hasGateway) {
      try {
        const before = Date.now();
        const r = await tt.queryDate(l.lockId);
        const skewSec = Math.round((r.date - (before + Date.now()) / 2) / 1000) || 0;
        row.clockSkewSec = skewSec;
        row.lockLocalTime = policy.localParts(new Date(r.date), tz).label;
        // A whole-hour skew right after a DST change = the lock did not follow it.
        row.clockVerdict = Math.abs(skewSec) < 120 ? 'ok' : Math.abs(Math.abs(skewSec) - 3600) < 300 ? 'OFF BY ONE HOUR (DST not applied?)' : 'drift';
      } catch (e) { row.clockError = e.errcode === ERR.NO_GATEWAY ? 'gateway offline' : e.message; }
    }
    try {
      const p = await tt.listPasscodes(l.lockId, 1, 100);
      row.passcodes = p.total ?? (p.list || []).length;
    } catch (e) { row.passcodes = `error: ${e.message}`; }
    report.locks.push(row);
  }
  console.table(report.locks);
  const drift = report.locks.filter(r => r.clockVerdict && r.clockVerdict !== 'ok');
  check('lock clocks', drift.length === 0 ? true : false, drift.length ? drift.map(r => `${r.alias}: ${r.clockVerdict} (${r.clockSkewSec}s)`).join('; ') : 'all gateway locks within 2 minutes');
  const offline = report.locks.filter(r => !r.gateway);
  if (offline.length) check('locks without gateway', null, `${offline.map(r => r.alias).join(', ')} — codes cannot be revoked remotely; clocks cannot be checked or corrected`);

  if (writeLock) await writeTest(tt, locks.find(l => Number(l.lockId) === writeLock));
  return finish();
}

async function writeTest(tt, lock) {
  if (!lock) { check('write test', false, 'lock not in this account'); return; }
  const start = Date.now();
  const created = await tt.createPasscode({ lockId: lock.lockId, keyboardPwdName: 'AccessX check', keyboardPwdType: 3, startDate: start, endDate: start + 3600e3 });
  check('create 1-hour period passcode', Boolean(created.keyboardPwdId), `code ${created.keyboardPwd} (id ${created.keyboardPwdId}) — TYPE IT ON THE KEYPAD NOW: it should open`);
  check('listed in the cloud', await tt.passcodeExists(lock.lockId, created.keyboardPwdId));
  try {
    await tt.deletePasscode(lock.lockId, created.keyboardPwdId, { deleteType: 2 });
    const still = await tt.passcodeExists(lock.lockId, created.keyboardPwdId);
    check('delete via gateway (deleteType=2)', !still, `${still ? 'still listed!' : 'gone from the cloud list'} — TYPE THE CODE AGAIN: it must NOT open`);
  } catch (e) {
    if (e.errcode === ERR.NO_GATEWAY) {
      check('delete via gateway (deleteType=2)', lock.hasGateway ? false : null,
        `-2012 no gateway: the code keeps working until removed on site via the TTLock app (Bluetooth). It expires by itself at ${new Date(start + 3600e3).toISOString()}`);
    } else check('delete via gateway (deleteType=2)', false, e.message);
  }
}

function finish() {
  if (jsonOut) require('fs').writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  const failed = report.checks.filter(c => c.ok === false).length;
  console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'}${jsonOut ? ` — report saved to ${jsonOut}` : ''}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
