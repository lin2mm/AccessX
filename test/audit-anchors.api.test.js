const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { boot } = require('../support/boot');
const auditCore = require('../audit-core');
const { generateSigningKey, verifyAnchor } = require('../audit-anchor-core');
const { createAuditOps } = require('../audit-ops');
const { sha256Hex } = require('../audit-core');

const DAY = 864e5;
const VERIFY = path.join(__dirname, '..', 'scripts', 'verify-audit-export.js');

/** The customer's side: a webhook that keeps every anchor it receives. */
async function receiver(status = 200) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { got.push(JSON.parse(body)); res.writeHead(status); res.end(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/hooks/anchor`, got, close: () => new Promise(r => server.close(r)) };
}

function verifyCli(exportDoc, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-verify-'));
  const file = path.join(dir, 'export.json');
  fs.writeFileSync(file, JSON.stringify(exportDoc));
  const files = { file, dir };
  const args = [VERIFY, file];
  for (const [flag, data] of extra) { const f = path.join(dir, `${flag.slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(data)); args.push(flag, f); }
  try { return { code: 0, out: execFileSync(process.execPath, args, { encoding: 'utf8' }), files }; } catch (e) { return { code: e.status, out: e.stdout, files }; }
}

async function setup(t, env = {}) {
  const key = await generateSigningKey();
  const api = await boot({ ADMIN_TOKEN: 'owner-token', AUDIT_SIGNING_KEY: JSON.stringify(key.private), ALLOW_HTTP_WEBHOOKS: '1', RECONCILE_INTERVAL_MIN: '0', ...env });
  t.after(api.close);
  return { api, key, owner: { token: 'owner-token' } };
}

test('anchors are signed, recorded in the chain, delivered to the customer, and not repeated without new activity', async t => {
  const { api, key, owner } = await setup(t);
  const hook = await receiver();
  t.after(hook.close);
  assert.equal((await api.call('PUT', '/api/audit/settings', { ...owner, body: { anchorWebhook: hook.url } })).status, 200);

  const a = await api.call('POST', '/api/audit/anchor', owner);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.anchor.deliveryStatus, 'delivered');
  assert.equal(hook.got.length, 1);
  const held = hook.got[0];
  assert.equal(held.type, 'accessx.audit.anchor');
  assert.equal(held.publicKey.x, key.private.x);
  assert.equal(await verifyAnchor(held, { tenantId: 't_default', publicKey: held.publicKey }), true);
  assert.equal(await verifyAnchor(held, { tenantId: 't_other', publicKey: held.publicKey }), false, 'an anchor cannot be replayed as another tenant\'s');
  const head = (await api.call('GET', '/api/audit/verify', owner)).body.verification.head;
  assert.equal(head.seq, held.seq + 1, 'the anchor itself is the next chain entry');

  const again = await api.call('POST', '/api/audit/anchor', owner);
  assert.match(again.body.skipped, /no new entries/);
  assert.equal(hook.got.length, 1);

  const list = await api.call('GET', '/api/audit/anchors', owner);
  assert.equal(list.body.anchors.length, 1);
  assert.equal(list.body.publicKey.kid, key.keyId);
  assert.equal(list.body.settings.anchorWebhookHost.startsWith('127.0.0.1:'), true);
  assert.equal(JSON.stringify(list.body).includes('/hooks/anchor'), false, 'webhook path (often a secret) is not shown back');

  // A failing webhook is recorded, not fatal.
  const bad = await receiver(500);
  t.after(bad.close);
  await api.call('PUT', '/api/audit/settings', { ...owner, body: { anchorWebhook: bad.url } });
  const failed = await api.call('POST', '/api/audit/anchor', owner);
  assert.equal(failed.body.anchor.deliveryStatus, 'failed: HTTP 500');
});

test('offline verifier: detects edits, and a full chain rewrite only with the anchors the customer kept', async t => {
  const { api, key, owner } = await setup(t);
  const hook = await receiver();
  t.after(hook.close);
  await api.call('PUT', '/api/audit/settings', { ...owner, body: { anchorWebhook: hook.url } });
  await api.call('POST', '/api/users/u1/suspend', owner);
  await api.call('POST', '/api/audit/anchor', owner);
  const pinned = { kty: 'OKP', crv: 'Ed25519', x: key.private.x, kid: key.keyId };

  const exp = (await api.call('GET', '/api/audit/export', owner)).body;
  let r = verifyCli(exp, [['--anchors', hook.got], ['--pubkey', pinned]]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /VERIFIED/);
  assert.match(r.out, /starts at genesis/);

  // (a) someone edits one exported entry → caught by the hashes alone
  const edited = JSON.parse(JSON.stringify(exp));
  edited.entries[3].detail = 'nothing to see here';
  r = verifyCli(edited);
  assert.equal(r.code, 1);
  assert.match(r.out, /chain broken at seq 4: entry content was modified/);

  // (b) an insider with database access rewrites history and RE-HASHES the whole chain
  const db = api.server.store.sql.raw;
  db.exec('DROP TRIGGER audit_events_no_update');
  const rows = db.prepare("SELECT * FROM audit_events WHERE tenant_id = 't_default' ORDER BY seq").all();
  const target = rows.find(x => x.action === 'users.suspend');
  const pendingEntries = rows.map(x => ({ id: x.id, ts: x.ts, actor: x.actor, action: x.action, detail: x.seq === target.seq ? 'u4' : x.detail })); // blame someone else
  const resealed = auditCore.seal(null, pendingEntries);
  const upd = db.prepare("UPDATE audit_events SET detail = ?, prev_hash = ?, hash = ? WHERE tenant_id = 't_default' AND seq = ?");
  for (const e of resealed) upd.run(e.detail, e.prevHash, e.hash, e.seq);

  // …and removes the anchors AccessX stored, which would otherwise give it away.
  assert.throws(() => db.prepare('DELETE FROM audit_anchors').run(), /append-only/, 'not by accident, at least');
  db.exec('DROP TRIGGER audit_anchors_no_delete');
  db.prepare('DELETE FROM audit_anchors').run();

  const serverSays = (await api.call('GET', '/api/audit/verify', owner)).body.verification;
  assert.equal(serverSays.ok, true, 'a rewritten chain is internally consistent — the server alone cannot tell');
  const rewritten = (await api.call('GET', '/api/audit/export', owner)).body;
  r = verifyCli(rewritten);
  assert.equal(r.code, 0, 'without the customer\'s copies the rewrite passes');
  r = verifyCli(rewritten, [['--anchors', hook.got], ['--pubkey', pinned]]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /DOES NOT MATCH — the chain was rewritten after this anchor/);

  // (c) a forged anchor (attacker re-signs with their own key) fails against the pinned key
  const forgedKey = await generateSigningKey();
  const forged = { ...rewritten, publicKey: { kty: 'OKP', crv: 'Ed25519', x: forgedKey.private.x, kid: forgedKey.keyId } };
  r = verifyCli(forged, [['--pubkey', pinned]]);
  assert.match(r.out, /signed with a different key than the one you pinned/);
});

test('retention: purge only below an externally delivered anchor, via a checkpoint; the trigger blocks everything else', async t => {
  const { api, key, owner } = await setup(t);
  const store = api.server.store;
  for (let i = 0; i < 3; i++) await api.call('POST', '/api/doors/9001/unlock', { ...owner, body: { reason: `delivery ${i}` } });
  assert.equal((await api.call('PUT', '/api/audit/settings', { ...owner, body: { retentionDays: 30 } })).status, 400, 'minimum 365 days');
  assert.equal((await api.call('PUT', '/api/audit/settings', { ...owner, body: { retentionDays: 365 } })).status, 200);
  assert.equal((await api.call('POST', '/api/audit/purge', owner)).body.purged, 0, 'nothing is a year old yet');

  // 400 days later…
  const later = () => Date.now() + 400 * DAY;
  let delivered = 0;
  const future = createAuditOps({
    store, signingKeyJson: JSON.stringify(key.private), now: later, allowHttpWebhooks: true,
    fetchFn: async () => { delivered++; return { status: 200 }; },
  });
  await assert.rejects(future.purge('t_default', {}), /not covered by an anchor delivered outside AccessX/);
  // An anchor that never left AccessX does not count…
  assert.equal((await future.anchor('t_default', { actor: 'owner' })).anchor.deliveryStatus, 'none');
  await assert.rejects(future.purge('t_default', {}), /not covered by an anchor delivered outside AccessX/);
  assert.equal(delivered, 0);
  await future.saveSettings('t_default', { anchorWebhook: 'https://audit.example.com/anchors' }, 'owner');
  // the entries written so far are "old"; anchor them, then the purge may proceed
  const anchored = await future.anchor('t_default', { actor: 'owner' });
  assert.equal(anchored.anchor.deliveryStatus, 'delivered');
  assert.equal(delivered, 1);
  const before = (await api.call('GET', '/api/audit/verify', owner)).body.verification;
  const out = await future.purge('t_default', {});
  assert.ok(out.purged > 10, JSON.stringify(out));
  const after = (await api.call('GET', '/api/audit/verify', owner)).body.verification;
  assert.equal(after.ok, true, 'verification restarts at the checkpoint');
  assert.equal(after.checkpoint.seq, out.checkpoint.seq);
  assert.equal(after.head.seq, before.head.seq + 1, 'only the audit.purge entry was appended');
  assert.equal(after.head.hash === before.head.hash, false);
  assert.equal(out.coveredByAnchor, anchored.anchor.seq);
  assert.match((await api.call('GET', '/api/audit?action=audit.purge', owner)).body.log[0].detail, /covered by anchor seq=/);

  // The DB still refuses deletes above the checkpoint, and checkpoints are permanent.
  const db = store.sql.raw;
  assert.throws(() => db.prepare("DELETE FROM audit_events WHERE tenant_id = 't_default'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM audit_checkpoints").run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE audit_checkpoints SET seq = 999999").run(), /append-only/);

  // An export after the purge starts at the checkpoint and still verifies offline.
  const exp = (await api.call('GET', '/api/audit/export', owner)).body;
  assert.equal(exp.range.anchoredStart, 'retention checkpoint');
  const r = verifyCli(exp);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /starts at retention checkpoint/);
});

test('webhook URLs are checked (https, public, no credentials) and settings/anchor/purge are owner-only', async t => {
  const OPERATORS = JSON.stringify([
    { id: 'op_aud', name: 'Auditor', role: 'r_view', tokenSha256: sha256Hex('aud-token') },
    { id: 'op_gym', name: 'Gym manager', role: 'r_manager', siteIds: ['site_gym'], tokenSha256: sha256Hex('gym-token') },
  ]);
  const { api, owner } = await setup(t, { ALLOW_HTTP_WEBHOOKS: '0', OPERATORS });
  for (const bad of ['http://audit.example.com/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://user:pw@audit.example.com/x', 'https://localhost/x', 'https://[::1]/x', 'not a url']) {
    const r = await api.call('PUT', '/api/audit/settings', { ...owner, body: { anchorWebhook: bad } });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await api.call('PUT', '/api/audit/settings', { ...owner, body: { anchorWebhook: 'https://audit.example.com/x' } })).status, 200);
  const aud = { token: 'aud-token' };
  assert.equal((await api.call('GET', '/api/audit/export', aud)).status, 200, 'auditors may export');
  assert.equal((await api.call('GET', '/api/reports/evidence', aud)).status, 200, 'auditors may pull the evidence pack');
  for (const [m, u] of [['PUT', '/api/audit/settings'], ['POST', '/api/audit/anchor'], ['POST', '/api/audit/purge']]) {
    assert.equal((await api.call(m, u, { ...aud, body: {} })).status, 403, `${m} ${u}`);
  }
  const gym = { token: 'gym-token' };
  assert.equal((await api.call('GET', '/api/audit/export', gym)).status, 403, 'site-scoped operators cannot export the tenant-wide trail');
  assert.equal((await api.call('GET', '/api/reports/evidence', gym)).status, 403);
  const exportEntries = (await api.call('GET', '/api/audit?action=audit.export', owner)).body.log;
  assert.equal(exportEntries.length, 1, 'the export itself is on the record');
});

test('evidence pack: removal times, administrators with flags, identity, audit state, control mapping', async t => {
  const { api, owner } = await setup(t);
  await api.call('POST', '/api/passcode', { ...owner, body: { lockId: 9002, userId: 'u2' } });
  await api.call('POST', '/api/users/u2/suspend', owner);
  await api.call('POST', '/api/operators', { ...owner, body: { name: 'Second owner', role: 'r_owner' } });
  await api.call('POST', '/api/audit/anchor', owner);
  const r = await api.call('GET', '/api/reports/evidence?days=30', owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = r.body.evidence;
  assert.equal(e.accessRemoval.remote.count, 1);
  assert.ok(e.administrators.people.find(p => p.name === 'Second owner').flags.includes('owner without single sign-on'));
  assert.equal(e.auditTrail.verification.ok, true);
  assert.equal(e.auditTrail.anchors.inPeriod, 1);
  assert.equal(e.auditTrail.anchors.signed, 1);
  assert.ok(e.controls.some(c => c.control === 'A.7.2') && e.controls.some(c => c.control === 'CC6.4'));
  assert.match(e.disclaimer, /not a certification/);
  assert.equal(e.doors.total, 7);
  assert.equal((await api.call('GET', '/api/audit?action=report.evidence', owner)).body.log.length, 1);
});
