#!/usr/bin/env node
/**
 * Offline verifier for an AccessX audit export — for auditors. Needs only
 * Node 22 and this file's two sibling modules; it never talks to AccessX.
 *
 *   node scripts/verify-audit-export.js export.json \
 *        [--anchors anchors.json]   # anchors YOU received (webhook bodies; JSON array or JSONL)
 *        [--pubkey key.json]        # the AccessX public key you pinned earlier (JWK)
 *
 * Checks
 *  1. every entry's hash, prevHash link and seq (tamper, delete, reorder);
 *  2. where the export starts: genesis, a retention checkpoint, or a segment;
 *  3. every anchor inside the export: Ed25519 signature + matches the entry;
 *  4. every anchor YOU hold: signature + the export has that exact hash at
 *     that seq. This is what catches a rewrite of the WHOLE chain, which
 *     check 1 cannot (a rewritten chain is internally consistent).
 */
const fs = require('node:fs');
const path = require('node:path');
const auditCore = require(path.join(__dirname, '..', 'audit-core'));
const { verifyAnchor } = require(path.join(__dirname, '..', 'audit-anchor-core'));

const args = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const file = args.find(a => !a.startsWith('--') && a !== opt('--anchors') && a !== opt('--pubkey'));
if (!file) { console.error('usage: verify-audit-export.js export.json [--anchors anchors.json] [--pubkey key.json]'); process.exit(2); }

const readJsonish = f => {
  const text = fs.readFileSync(f, 'utf8').trim();
  try { return JSON.parse(text); } catch { return text.split('\n').filter(Boolean).map(l => JSON.parse(l)); }
};
const doc = readJsonish(file);
const exp = doc.format ? doc : doc.body || doc; // raw API response or bare export
if (exp.format !== 'accessx-audit-export-v1') { console.error('not an accessx-audit-export-v1 document'); process.exit(2); }

let failures = 0;
const line = (ok, msg) => { if (ok === false) failures++; console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'WARN'}  ${msg}`); };

(async () => {
  const tenantId = exp.tenant.id;
  const entries = exp.entries || [];
  console.log(`tenant ${exp.tenant.name} (${tenantId}) · ${entries.length} entries · exported ${exp.exportedAt}\n`);

  // 1. chain integrity (recomputed here, not trusted from the file)
  if (entries.length) {
    const v = auditCore.verify(entries, { seq: entries[0].seq - 1, hash: entries[0].prevHash });
    line(v.ok, v.ok ? `chain intact: seq ${entries[0].seq}..${v.head.seq}, head ${v.head.hash.slice(0, 16)}…` : `chain broken at seq ${v.brokenAt}: ${v.problem}`);
  }
  // 2. start
  const first = entries[0];
  if (first) {
    if (first.seq === 1) line(first.prevHash === auditCore.GENESIS, 'starts at genesis');
    else if (exp.checkpoint && first.seq === exp.checkpoint.seq + 1) line(first.prevHash === exp.checkpoint.hash, `starts at retention checkpoint seq ${exp.checkpoint.seq} (older entries purged by policy)`);
    else line(null, `segment starting at seq ${first.seq}: compare prevHash ${first.prevHash.slice(0, 16)}… with the previous export`);
  }

  // key: pinned beats embedded
  const pinned = opt('--pubkey') ? readJsonish(opt('--pubkey')) : null;
  const key = pinned || exp.publicKey;
  if (!key) line(null, 'no public key: anchor signatures cannot be checked');
  else if (!pinned) line(null, `using the public key embedded in the export (kid ${key.kid}); pin it with --pubkey for real audits`);
  else if (exp.publicKey && exp.publicKey.x !== pinned.x) line(false, 'the export was signed with a different key than the one you pinned');

  const bySeq = new Map(entries.map(e => [e.seq, e]));
  const checkAnchor = async (a, label) => {
    const sigOk = key ? await verifyAnchor(a, { tenantId, publicKey: key }) : null;
    if (a.signature && key) line(sigOk, `${label} seq ${a.seq}: signature ${sigOk ? 'valid' : 'INVALID'}`);
    else if (!a.signature) line(null, `${label} seq ${a.seq}: unsigned`);
    const e = bySeq.get(a.seq);
    if (e) line(e.hash === a.hash, `${label} seq ${a.seq}: ${e.hash === a.hash ? 'matches the chain' : 'DOES NOT MATCH — the chain was rewritten after this anchor'}`);
    else line(null, `${label} seq ${a.seq}: outside this export's range`);
  };
  // 3. anchors in the export
  for (const a of exp.anchors || []) await checkAnchor(a, 'anchor (in export)');
  // 4. anchors the customer kept
  if (opt('--anchors')) {
    const held = [].concat(readJsonish(opt('--anchors')));
    for (const a of held) {
      if (a.tenant && a.tenant.id && a.tenant.id !== tenantId) { line(false, `held anchor seq ${a.seq} is for another tenant (${a.tenant.id})`); continue; }
      await checkAnchor(a, 'anchor (held by you)');
    }
  } else line(null, 'no --anchors given: a full rewrite of the chain would not be detected by this run');

  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'VERIFIED'}`);
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exit(2); });
