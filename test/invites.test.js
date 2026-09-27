const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');

const OWNER = { token: 'owner-token' };
const DESK = { token: 'desk-token' };
const GYM_DESK = { token: 'gym-desk-token' };
const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
const OPERATORS = JSON.stringify([
  { id: 'op_desk', name: 'Reception', role: 'r_front_desk', siteIds: ['site_river'], tokenSha256: sha256Hex('desk-token') },
  { id: 'op_gdesk', name: 'Gym reception', role: 'r_front_desk', siteIds: ['site_gym'], tokenSha256: sha256Hex('gym-desk-token') },
]);
const VISITOR = 'Ines Invitee';
const londonDate = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 864e5));

/** Fake Resend: records every email (to, text). */
async function mailbox(t, statuses = [200]) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { got.push(JSON.parse(b || '{}')); res.writeHead(statuses[Math.min(got.length - 1, statuses.length - 1)], { 'content-type': 'application/json' }); res.end('{"id":"e"}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, got };
}
async function setup(t, statuses, env = {}) {
  const mail = await mailbox(t, statuses);
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, RECONCILE_INTERVAL_MIN: '0', PUBLIC_URL: 'https://doors.example',
    EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'desk@accessx.example', EMAIL_API_BASE: mail.base, ...env });
  t.after(api.close);
  return { api, mail };
}
const inviteBody = (extra = {}) => ({ visitorEmail: 'ines@guest.example', hostUserId: 'u1', lockIds: [9001], startLocal: `${londonDate(2)}T09:00`, endLocal: `${londonDate(2)}T17:00`, ...extra });
const pub = (api, body) => fetch(`${api.base}/api/visit-invite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const tokenOf = url => url.split('#')[1];

test('invite → the visitor registers → the code goes to the address reception fixed (a forwarded link cannot redirect it); one use; never shown', async t => {
  const { api, mail } = await setup(t);
  const bad = await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody({ visitorEmail: undefined }) });
  assert.equal(bad.status, 400);
  assert.equal((await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody({ visitorPhone: '+447700900123' }) })).status, 400, 'one address only');
  assert.equal((await api.call('POST', '/api/visit-invites', { ...GYM_DESK, body: inviteBody() })).status, 404, 'other site: not even visible');

  const r = await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.delivery, 'delivered');
  assert.match(r.body.inviteUrl, /^https:\/\/doors\.example\/invite#[A-Za-z0-9_-]{24}$/);
  assert.equal(r.body.invite.status, 'open');
  assert.equal(r.body.invite.requireApproval, false);
  assert.deepEqual(mail.got[0].to, ['ines@guest.example']);
  assert.ok(mail.got[0].text.includes(r.body.inviteUrl));
  assert.match(mail.got[0].subject, /Sarah Kelly invited you to Riverside Office/);
  const token = tokenOf(r.body.inviteUrl);
  const row = await api.server.store.sql.first('SELECT token_hash FROM visit_invites WHERE id = ?', [r.body.invite.id]);
  assert.ok(!row.token_hash.includes(token));
  const audit = (await api.call('GET', '/api/audit?action=invite.create', OWNER)).body.log[0];
  assert.ok(!audit.detail.includes('ines'), 'no address in the audit chain');

  assert.equal((await pub(api, { token: 'x'.repeat(24), action: 'status' })).status, 404);
  const st = await pub(api, { token, action: 'status' });
  assert.equal(st.status, 200);
  assert.equal(st.body.sendTo, 'i•••@guest.example');
  assert.equal(st.body.host, 'Sarah', 'first name only');
  assert.deepEqual(st.body.doors, ['Main Entrance']);
  assert.ok(!JSON.stringify(st.body).includes('ines@'), 'a leaked link does not reveal the address');

  // Whoever holds the link submits — even trying to supply their own address.
  const sub = await pub(api, { token, action: 'submit', name: VISITOR, company: 'Guest Co', startLocal: `${londonDate(2)}T10:00`, visitorEmail: 'attacker@evil.example', visitorPhone: '+15550000000' });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.deepEqual(sub.body, { ok: true, pending: false, sentTo: 'i•••@guest.example' });
  assert.equal(mail.got.length, 2);
  assert.deepEqual(mail.got[1].to, ['ines@guest.example'], 'the code went to the fixed address');
  assert.ok(!JSON.stringify(mail.got).includes('evil.example'));
  assert.match(mail.got[1].text, /Hello Ines Invitee,[\s\S]*Main Entrance: \d{6}/);
  assert.match(mail.got[1].text, /https:\/\/doors\.example\/checkout#/, 'with a check-out link');

  const visits = (await api.call('GET', '/api/visits', OWNER)).body.visits;
  const v = visits.find(x => x.visitorName === VISITOR);
  assert.ok(v);
  assert.equal(v.createdBy, `invite:${r.body.invite.id}`);
  assert.match(v.startAt, /T09:00:00.000Z$|T10:00/, 'arrival 10:00 London = 09:00 UTC in summer');
  const inv = (await api.call('GET', '/api/visit-invites', DESK)).body.invites[0];
  assert.equal(inv.status, 'used');
  assert.equal(inv.visitId, v.id);
  assert.equal((await pub(api, { token, action: 'submit', name: 'Again' })).status, 404, 'one use');
  assert.deepEqual((await api.call('GET', '/api/audit?action=invite.used', OWNER)).body.log.map(e => e.detail), [`${r.body.invite.id} visit ${v.id}`]);

  // Erasing the visitor also erases the invitation's copy.
  await api.call('POST', `/api/visits/${v.id}/erase`, { ...DESK, body: {} });
  const after = await api.server.store.sql.first('SELECT contact, submitted_name, erased_at FROM visit_invites WHERE id = ?', [r.body.invite.id]);
  assert.deepEqual({ ...after, erased_at: Boolean(after.erased_at) }, { contact: null, submitted_name: null, erased_at: true });
});

test('re-checked at registration: suspended host, a door made sensitive, arrival outside the window, too many attempts, revoked', async t => {
  const { api } = await setup(t);
  const mk = async () => { const r = await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody() }); assert.equal(r.status, 200, JSON.stringify(r.body)); return { id: r.body.invite.id, token: tokenOf(r.body.inviteUrl) }; };

  const a = await mk();
  const out = await pub(api, { token: a.token, action: 'submit', name: VISITOR, startLocal: `${londonDate(2)}T18:00` });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /arrival time inside the invitation/);
  assert.equal((await pub(api, { token: a.token, action: 'submit', name: '' })).body.error, 'Please enter your name.');
  for (let i = 0; i < 3; i++) await pub(api, { token: a.token, action: 'submit', name: '' });
  assert.equal((await pub(api, { token: a.token, action: 'status' })).status, 404, 'five attempts, then the link is dead');

  const b = await mk();
  await api.call('POST', '/api/users/u1/suspend', OWNER);
  const sb = await pub(api, { token: b.token, action: 'submit', name: VISITOR });
  assert.equal(sb.status, 400);
  assert.match(sb.body.error, /can no longer be used/);
  assert.match((await api.call('GET', '/api/audit?action=invite.failed', OWNER)).body.log[0].detail, /suspended/);
  await api.call('POST', '/api/users/u1/unsuspend', OWNER);

  const c = await mk();
  await api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Lobby (now sensitive)', siteId: 'site_river', lockIds: [9001], sensitive: true } });
  const sc = await pub(api, { token: c.token, action: 'submit', name: VISITOR });
  assert.equal(sc.status, 400);
  assert.match((await api.call('GET', '/api/audit?action=invite.failed', OWNER)).body.log[0].detail, /sensitive/);
  assert.equal((await api.call('GET', '/api/visits', OWNER)).body.visits.length, 0, 'no visit was created');

  const d = (await api.call('GET', '/api/visit-invites', OWNER)).body.invites.find(x => x.id === a.id);
  assert.equal(d.status, 'open', 'listed as open (attempts exhausted)');
  const rv = await api.call('POST', `/api/visit-invites/${c.id}/revoke`, { ...DESK, body: {} });
  assert.equal(rv.body.invite.status, 'revoked');
  assert.equal((await pub(api, { token: c.token, action: 'status' })).status, 404);
  assert.equal((await api.call('POST', `/api/visit-invites/${c.id}/revoke`, { ...DESK, body: {} })).status, 409);
});

test('if the code cannot be delivered, the new visit is cancelled at once (no untracked code) and the invitation stays usable', async t => {
  const { api, mail } = await setup(t, [200, 500, 200]);
  const r = await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody({ lockIds: [9001, 9004] }) });
  const token = tokenOf(r.body.inviteUrl);
  const f = await pub(api, { token, action: 'submit', name: VISITOR });
  assert.equal(f.status, 400);
  assert.match(f.body.error, /could not send your code/);
  const v = (await api.call('GET', '/api/visits?range=all', OWNER)).body.visits[0];
  assert.equal(v.status, 'cancelled');
  assert.deepEqual(v.codes.map(c => c.status).sort(), ['pending_removal', 'revoked'], 'gateway door deleted, the other flagged for removal');
  const ok = await pub(api, { token, action: 'submit', name: VISITOR });
  assert.equal(ok.status, 200, 'second try works');
  assert.equal(mail.got.length, 3);
});

test('sites with sensitive doors: registrations wait for reception (only an owner can waive it); approve delivers, reject ends it', async t => {
  const { api, mail } = await setup(t, [200], { ALLOW_HTTP_WEBHOOKS: '1' });
  await api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Server room', siteId: 'site_river', lockIds: [9002], sensitive: true } });
  assert.equal((await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody({ requireApproval: false }) })).status, 403);
  const waived = await api.call('POST', '/api/visit-invites', { ...OWNER, body: inviteBody({ requireApproval: false }) });
  assert.equal(waived.body.invite.requireApproval, false, 'owner may waive');

  const r = await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody() });
  assert.equal(r.body.invite.requireApproval, true, 'default on a sensitive site');
  const token = tokenOf(r.body.inviteUrl);
  assert.equal((await pub(api, { token, action: 'status' })).body.requireApproval, true);
  const sub = await pub(api, { token, action: 'submit', name: VISITOR, company: 'Guest Co' });
  assert.deepEqual(sub.body, { ok: true, pending: true, sentTo: 'i•••@guest.example' });
  const n = mail.got.length;
  const list = (await api.call('GET', '/api/visit-invites', DESK)).body.invites.find(x => x.id === r.body.invite.id);
  assert.equal(list.status, 'submitted');
  assert.equal(list.submittedName, VISITOR);
  assert.equal((await pub(api, { token, action: 'status' })).status, 404, 'the link is done once submitted');

  assert.equal((await api.call('POST', `/api/visit-invites/${r.body.invite.id}/approve`, { ...GYM_DESK, body: {} })).status, 404, 'other site');
  const ap = await api.call('POST', `/api/visit-invites/${r.body.invite.id}/approve`, { ...DESK, body: {} });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.invite.status, 'used');
  assert.equal(ap.body.delivery, 'emailed');
  assert.deepEqual(mail.got[n].to, ['ines@guest.example']);
  assert.ok(!('codes' in ap.body), 'reception does not see the code either');
  assert.equal((await api.call('POST', `/api/visit-invites/${r.body.invite.id}/approve`, { ...DESK, body: {} })).status, 409);

  const r2 = await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody() });
  await pub(api, { token: tokenOf(r2.body.inviteUrl), action: 'submit', name: 'Someone' });
  const rj = await api.call('POST', `/api/visit-invites/${r2.body.invite.id}/reject`, { ...DESK, body: {} });
  assert.equal(rj.body.invite.status, 'rejected');
  assert.match((await api.call('GET', '/api/audit?action=invite.rejected', OWNER)).body.log[0].actor, /op_desk/);
});

test('invitations need PUBLIC_URL and a configured channel; expired ones are closed and erased by retention', async t => {
  const plain = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, SECRETS_KEY, RECONCILE_INTERVAL_MIN: '0' });
  t.after(plain.close);
  assert.match((await plain.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody() })).body.error, /PUBLIC_URL/);
  const { api } = await setup(t);
  assert.match((await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody({ visitorEmail: undefined, visitorPhone: '+447700900123' }) })).body.error, /SMS is not configured/);
  const r = await api.call('POST', '/api/visit-invites', { ...DESK, body: inviteBody() });
  await api.server.store.sql.batch([{ sql: 'UPDATE visit_invites SET expires_at = ? WHERE id = ?', params: [new Date(Date.now() - 40 * 864e5).toISOString(), r.body.invite.id] }]);
  assert.equal((await api.call('GET', '/api/visit-invites', DESK)).body.invites[0].status, 'expired');
  assert.equal((await pub(api, { token: tokenOf(r.body.inviteUrl), action: 'status' })).status, 404);
  await api.server.api.maintenance();
  const row = await api.server.store.sql.first('SELECT status, token_hash, contact, erased_at FROM visit_invites WHERE id = ?', [r.body.invite.id]);
  assert.equal(row.status, 'expired');
  assert.equal(row.token_hash, null);
  assert.equal(row.contact, null, 'retention (30 days) erased the address');
  assert.ok(row.erased_at);
});
