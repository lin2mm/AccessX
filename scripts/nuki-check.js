#!/usr/bin/env node
/**
 * Real-device check for a Nuki account (R20; docs/25-NUKI.md §6). Run it ON
 * SITE, with the customer's real token, before promising anything.
 *
 *   NUKI_API_TOKEN=… node scripts/nuki-check.js                 # read-only
 *   NUKI_API_TOKEN=… node scripts/nuki-check.js --write 17xxxxxx # + create, confirm, delete a test code on that lock
 *   … --json report.json                                         # also save the report
 *   (NUKI_API_BASE=http://127.0.0.1:4002 points it at support/fake-nuki.js.)
 *
 * Read-only: the token works; every lock with its type, online state (bridge /
 * Wi-Fi), battery, keypad, how full it is (200 authorizations), and whether the
 * activity log is readable (scope smartlock.log). Listing codes needs scope
 * smartlock.auth: without it AccessX refuses to connect the account.
 *
 * --write <smartlockId>: the same code path AccessX uses (vendor-nuki-core.js):
 * creates a 1-hour keypad code "AccessX check", waits until the Nuki cloud lists
 * it (writes are asynchronous), prints the digits, deletes it and waits until it
 * is gone. TYPE THE CODE ON THE KEYPAD before and after the delete: the keypad
 * is the only proof that counts (the cloud list can be ahead of the lock).
 * Exit code 1 if any check fails.
 */
const fs = require('node:fs');
const { Nuki, codeOf } = require('../nuki');
const { createNukiVendor, mapLock, KEYPAD_CODE } = require('../vendor-nuki-core');

const AUTHS_MAX = 200;
const args = process.argv.slice(2);
const writeLock = args.includes('--write') ? Number(args[args.indexOf('--write') + 1]) : null;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const report = { at: new Date().toISOString(), checks: [], locks: [] };
const check = (name, ok, detail = '') => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const token = process.env.NUKI_API_TOKEN;
  if (!token) { console.error('missing env: NUKI_API_TOKEN (Nuki Web → API → generate API token)'); process.exit(2); }
  const nuki = new Nuki({ token, apiBase: process.env.NUKI_API_BASE || '' });

  let raw;
  try {
    raw = await nuki.listSmartlocks();
    check('token accepted, locks listed', true, `${raw.length} lock(s)`);
  } catch (e) {
    check('token accepted, locks listed', false, e.message);
    return;
  }
  if (!raw.length) check('at least one lock', false, 'this account sees no locks: is it the account the locks were set up with (or shared to as admin)?');

  for (const s of raw) {
    const l = mapLock(s);
    const row = { lockId: l.lockId, name: l.lockAlias, type: s.type, online: l.online, battery: l.electricQuantity, keypad: l.keypad };
    let auths = null;
    try {
      auths = await nuki.listAuths(l.lockId);
      row.authorizations = auths.length;
      row.keypadCodes = auths.filter(a => Number(a.type) === KEYPAD_CODE).length;
    } catch (e) {
      row.authError = e.message;
    }
    try { const logs = await nuki.logs(l.lockId, 1); row.lastLog = logs[0] ? logs[0].date : null; } catch (e) { row.logError = e.message; }
    report.locks.push(row);

    const tag = `${l.lockAlias} (${l.lockId})`;
    check(`${tag}: online`, l.online, l.online ? '' : 'offline: new codes cannot reach it and revokes wait (pending_removal). Check the bridge / Wi-Fi');
    check(`${tag}: keypad paired`, l.keypad, l.keypad ? '' : 'no Nuki Keypad: AccessX can open it remotely but cannot issue codes');
    if (l.electricQuantity !== null && l.electricQuantity !== undefined) check(`${tag}: battery`, l.electricQuantity > 20 ? true : null, `${l.electricQuantity}%${l.electricQuantity <= 20 ? ' (replace soon)' : ''}`);
    if (auths) check(`${tag}: room for codes`, auths.length < AUTHS_MAX - 20, `${auths.length} of ~${AUTHS_MAX} authorizations used (older locks hold 100)`);
    else check(`${tag}: codes readable (scope smartlock.auth)`, false, row.authError);
    check(`${tag}: activity log readable (scope smartlock.log)`, !row.logError, row.logError || (row.lastLog ? `last entry ${row.lastLog}` : 'no entries yet'));
  }

  if (writeLock) {
    const vendor = createNukiVendor(nuki, { pollMs: 2000, pollTries: 15, cacheMs: 0 });
    const start = new Date(Date.now() - 60e3);
    const end = new Date(Date.now() + 3600e3);
    let created;
    const t0 = Date.now();
    try {
      created = await vendor.createPasscode({ lockId: writeLock, name: 'AccessX check', startAt: start.toISOString(), endAt: end.toISOString() });
      check('create a 1-hour keypad code and see it listed', true, `code ${created.keyboardPwd} (confirmed after ${((Date.now() - t0) / 1000).toFixed(1)} s) — type it on the keypad NOW: it should open`);
    } catch (e) {
      check('create a 1-hour keypad code and see it listed', false, e.message);
    }
    if (created) {
      if (process.stdin.isTTY) {
        process.stdout.write('Press Enter after trying the code on the keypad… ');
        await new Promise(r => process.stdin.once('data', r));
        process.stdin.pause();
      }
      try {
        await vendor.deletePasscode(writeLock, created.keyboardPwdId);
        let gone = false;
        for (let i = 0; i < 15 && !gone; i++) {
          if (i) await new Promise(r => setTimeout(r, 2000));
          gone = !(await nuki.listAuths(writeLock)).some(a => String(a.id) === String(created.keyboardPwdId) || codeOf(a) === created.keyboardPwd);
        }
        check('delete it and see it gone', gone, gone ? `type ${created.keyboardPwd} again: it must NOT open` : 'still listed after 30 s: remove "AccessX check" in the Nuki app and note it in the site log');
      } catch (e) {
        check('delete it and see it gone', false, `${e.message} — remove "AccessX check" in the Nuki app`);
      }
    }
  } else {
    check('write test', null, 'skipped (add --write <smartlockId> on site)');
  }
}

main()
  .catch(error => check('unexpected error', false, error.message))
  .finally(() => {
    if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    const failed = report.checks.filter(c => c.ok === false).length;
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
    process.exitCode = failed ? 1 : 0;
  });
