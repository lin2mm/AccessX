// R16 front-desk kiosk, walk-ins, printable list, Turnstile on signup, QR encoder (docs/22-KIOSK.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');
const kioskCore = require('../kiosk-core');
const qr = require('../public/qr.js');

const OWNER = { token: 'owner-token' };
const DESK = { token: 'desk-token' };
const GYM_DESK = { token: 'gym-desk-token' };
const OPERATORS = JSON.stringify([
  { id: 'op_desk', name: 'Reception', role: 'r_front_desk', siteIds: ['site_river'], tokenSha256: sha256Hex('desk-token') },
  { id: 'op_gdesk', name: 'Gym reception', role: 'r_front_desk', siteIds: ['site_gym'], tokenSha256: sha256Hex('gym-desk-token') },
]);

/** Europe/London wall clock `hours` from now, on the whole hour (visit end). */
const londonAt = hours => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(Date.now() + hours * 3600e3)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
};

async function mailbox(t) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { got.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"e"}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, got };
}
async function setup(t, env = {}) {
  const mail = await mailbox(t);
  const api = await boot({ ADMIN_TOKEN: 'owner-token', OPERATORS, RECONCILE_INTERVAL_MIN: '0', SECRETS_KEY: Buffer.alloc(32, 9).toString('base64'),
    EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'desk@accessx.example', EMAIL_API_BASE: mail.base, PUBLIC_URL: 'https://doors.example', ...env });
  t.after(api.close);
  return { api, mail, sql: api.server.store.sql.raw };
}
const kiosk = (api, body) => fetch(`${api.base}/api/kiosk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json(), headers: r.headers }));
async function pair(api, as = OWNER, siteId = 'site_river') {
  const r = await api.call('POST', '/api/kiosks', { ...as, body: { siteId, name: 'Front door' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const key = r.body.pairUrl.match(/#k=(kx_[A-Za-z0-9_-]+)$/)[1];
  return { id: r.body.kiosk.id, key, pairUrl: r.body.pairUrl };
}
const visitToday = (api, extra = {}) => api.call('POST', '/api/visits', { ...OWNER, body: {
  visitorName: 'Vera Visitorova', visitorEmail: 'vera@guest.example', company: 'Acme Audit', hostUserId: 'u1', lockIds: [9001], endLocal: londonAt(5), ...extra } });

test('pairing: the key is shown once, is not an operator, and is site-scoped for front desks', async t => {
  const { api, sql } = await setup(t);
  const k = await pair(api, DESK);
  assert.match(k.pairUrl, /^https:\/\/doors\.example\/kiosk#k=kx_/);
  const list = await api.call('GET', '/api/kiosks', DESK);
  assert.equal(list.body.kiosks.length, 1);
  assert.equal(JSON.stringify(list.body).includes(k.key), false, 'never listed again');
  assert.deepEqual(list.body.sites.map(s => s.id), ['site_river']);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM kiosks WHERE token_sha256 = ?').get(kioskCore.tokenHash(k.key)).n, 1, 'stored as a hash');
  // Another site's reception neither sees it nor can pair for it.
  assert.equal((await api.call('GET', '/api/kiosks', GYM_DESK)).body.kiosks.length, 0);
  assert.equal((await api.call('POST', '/api/kiosks', { ...GYM_DESK, body: { siteId: 'site_river' } })).status, 400);
  assert.equal((await api.call('POST', `/api/kiosks/${k.id}/revoke`, GYM_DESK)).status, 404);
  // The key opens nothing but the kiosk endpoint.
  assert.equal((await api.call('GET', '/api/visits', { token: k.key })).status, 401);
  assert.equal((await api.call('GET', '/api/walkins', { token: k.key })).status, 401);
  const info = await kiosk(api, { kiosk: k.key, action: 'info' });
  assert.equal(info.status, 200);
  assert.equal(info.body.site, 'Riverside Office');
  assert.equal(info.body.mode, 'kiosk');
  assert.equal(info.headers.get('cache-control'), 'no-store');
  assert.equal((await kiosk(api, { kiosk: 'kx_' + 'A'.repeat(43), action: 'info' })).status, 401);
  assert.equal((await kiosk(api, { action: 'info' })).status, 401);
  // Audit without the key.
  const audit = JSON.stringify((await api.call('GET', '/api/audit?limit=20', OWNER)).body);
  assert.match(audit, /kiosk\.create/);
  assert.equal(audit.includes(k.key), false);
});

test('check-in with the invitation email: notice accepted, host told once, nothing revealed to the kiosk', async t => {
  const { api, mail } = await setup(t);
  const notice = 'Please wear your badge.\nVisitor details are kept 30 days.';
  assert.equal((await api.call('PUT', '/api/visits/settings', { ...OWNER, body: { notice } })).status, 200);
  assert.equal((await api.call('PUT', '/api/visits/settings', { ...OWNER, body: { notice: 'x'.repeat(2001) } })).status, 400);
  const k = await pair(api);
  assert.equal((await kiosk(api, { kiosk: k.key, action: 'info' })).body.notice, notice);
  const v = await visitToday(api);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const future = await visitToday(api, { visitorEmail: 'later@guest.example', startLocal: londonAt(30).replace(/T\d\d/, 'T09'), endLocal: londonAt(30).replace(/T\d\d/, 'T12') });
  assert.equal(future.status, 200, JSON.stringify(future.body));
  const gym = await visitToday(api, { visitorEmail: 'gym@guest.example', lockIds: [9101] });
  assert.equal(gym.status, 200, JSON.stringify(gym.body));
  const sentBefore = mail.got.length;

  assert.equal((await kiosk(api, { kiosk: k.key, action: 'checkin', email: 'vera@guest.example' })).status, 400, 'notice must be accepted');
  const miss = await kiosk(api, { kiosk: k.key, action: 'checkin', email: 'nobody@guest.example', acceptNotice: true });
  assert.equal(miss.status, 404);
  assert.equal((await kiosk(api, { kiosk: k.key, action: 'checkin', email: 'later@guest.example', acceptNotice: true })).status, 404, 'not today');
  assert.equal((await kiosk(api, { kiosk: k.key, action: 'checkin', email: 'gym@guest.example', acceptNotice: true })).status, 404, 'another site');
  const ok = await kiosk(api, { kiosk: k.key, action: 'checkin', email: ' Vera@Guest.example ', acceptNotice: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { ok: true, checkedIn: true, already: false, host: 'Sarah' });
  assert.equal(JSON.stringify(ok.body).includes('Vera'), false, 'the kiosk learns no visitor details');
  const toHost = mail.got.slice(sentBefore);
  assert.equal(toHost.length, 1);
  assert.deepEqual(toHost[0].to, ['sarah@acme.co.uk']);
  assert.match(toHost[0].subject, /Vera Visitorova \(Acme Audit\) is at reception/);
  const again = await kiosk(api, { kiosk: k.key, action: 'checkin', email: 'vera@guest.example', acceptNotice: true });
  assert.equal(again.body.already, true);
  assert.equal(mail.got.length, sentBefore + 1, 'the host is told once');

  const visit = (await api.call('GET', '/api/visits', OWNER)).body.visits.find(x => x.id === v.body.visit.id);
  assert.ok(visit.checkedInAt);
  assert.equal(visit.noticeAccepted, true);
  const log = (await api.call('GET', '/api/audit?limit=30', OWNER)).body;
  const entry = JSON.stringify(log).match(/visit\.checked_in[^}]*/)[0];
  assert.match(entry, new RegExp(`kiosk ${k.id}`));
  assert.match(JSON.stringify(log), new RegExp(`"actor":"kiosk:${k.id}"`));
  assert.equal(/vera|Visitorova/i.test(entry), false, 'no personal data in the audit chain');
  assert.match(entry, new RegExp(`notice ${kioskCore.noticeHash(notice).slice(0, 12)}`));
});

test('phone pass: minted by the kiosk only, 10 minutes, signed; switching the kiosk off ends both', async t => {
  const { api, sql } = await setup(t);
  const k = await pair(api);
  await visitToday(api);
  const p = await kiosk(api, { kiosk: k.key, action: 'pass' });
  assert.equal(p.status, 200);
  assert.match(p.body.pass, /^p1\.t_default\.ksk_/);
  assert.ok(Date.parse(p.body.expiresAt) - Date.now() <= 600e3 + 1000);
  const phone = await kiosk(api, { pass: p.body.pass, action: 'info' });
  assert.equal(phone.body.mode, 'phone');
  assert.equal((await kiosk(api, { pass: p.body.pass, action: 'pass' })).status, 403, 'a phone cannot extend itself');
  const tampered = p.body.pass.slice(0, -1) + (p.body.pass.endsWith('0') ? '1' : '0');
  assert.equal((await kiosk(api, { pass: tampered, action: 'info' })).status, 401);
  const secret = sql.prepare('SELECT token_sha256 FROM kiosks WHERE id = ?').get(k.id).token_sha256;
  const old = await kioskCore.mintPhonePass({ tenantId: 't_default', kioskId: k.id, secret, now: Date.now() - 11 * 60e3 });
  assert.equal((await kiosk(api, { pass: old.pass, action: 'info' })).status, 401, 'expired');
  const forged = await kioskCore.mintPhonePass({ tenantId: 't_default', kioskId: k.id, secret: 'guess' });
  assert.equal((await kiosk(api, { pass: forged.pass, action: 'info' })).status, 401);
  const viaPhone = await kiosk(api, { pass: p.body.pass, action: 'checkin', email: 'vera@guest.example' });
  assert.equal(viaPhone.status, 200, JSON.stringify(viaPhone.body));
  assert.match(JSON.stringify((await api.call('GET', '/api/audit?limit=5', OWNER)).body), new RegExp(`kiosk:${k.id}:phone`));

  assert.equal((await api.call('POST', `/api/kiosks/${k.id}/revoke`, OWNER)).status, 200);
  assert.equal((await kiosk(api, { kiosk: k.key, action: 'info' })).status, 401);
  assert.equal((await kiosk(api, { pass: p.body.pass, action: 'info' })).status, 401);
});

test('walk-ins: no code from the kiosk; host matched narrowly; reception issues a code or dismisses', async t => {
  const { api, mail } = await setup(t);
  const k = await pair(api);
  assert.equal((await kiosk(api, { kiosk: k.key, action: 'walkin', name: '  ' })).status, 400);
  const before = mail.got.length;
  const w1 = await kiosk(api, { kiosk: k.key, action: 'walkin', name: 'Walter Walkin', company: 'Pipes Ltd', host: 'sarah  KELLY', email: 'walter@pipes.example' });
  assert.equal(w1.status, 200, JSON.stringify(w1.body));
  assert.equal(w1.body.host, 'Sarah');
  assert.equal(mail.got.length, before + 1);
  assert.match(mail.got[before].subject, /Walter Walkin \(Pipes Ltd\) is at reception and asked for you/);
  assert.equal(JSON.stringify(w1.body).includes('code'), false);
  // Two letters, a surname alone or a suspended person: no match, nothing revealed.
  for (const host of ['Sa', 'Kelly', 'Ex-Employee']) {
    const r = await kiosk(api, { kiosk: k.key, action: 'walkin', name: `Guest ${host}`, host });
    assert.equal(r.body.host, null, host);
  }
  const list = (await api.call('GET', '/api/walkins', DESK)).body.walkins;
  assert.equal(list.length, 4);
  assert.equal((await api.call('GET', '/api/walkins', GYM_DESK)).body.walkins.length, 0, 'other site');
  const walter = list.find(w => w.name === 'Walter Walkin');
  assert.equal(walter.hostUserId, 'u1');
  assert.equal(walter.hostNotified, 'delivered');

  // Doors at another site: refused before any code exists.
  assert.equal((await api.call('POST', '/api/visits', { ...OWNER, body: { visitorName: 'Walter Walkin', hostUserId: 'u1', lockIds: [9101], endLocal: londonAt(3), walkinId: walter.id } })).status, 400);
  const issued = await api.call('POST', '/api/visits', { ...DESK, body: { visitorName: 'Walter Walkin', company: 'Pipes Ltd', hostUserId: 'u1', lockIds: [9001], endLocal: londonAt(3), walkinId: walter.id } });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.codes.length, 1, 'reception sees the code, as for any visit');
  assert.ok(issued.body.visit.checkedInAt);
  assert.equal((await api.call('POST', '/api/visits', { ...DESK, body: { visitorName: 'Walter', hostUserId: 'u1', lockIds: [9001], endLocal: londonAt(3), walkinId: walter.id } })).status, 409, 'once');
  const all = (await api.call('GET', '/api/walkins?status=all', DESK)).body.walkins;
  assert.equal(all.find(w => w.id === walter.id).status, 'issued');
  assert.equal(all.find(w => w.id === walter.id).visitId, issued.body.visit.id);

  const other = all.find(w => w.name === 'Guest Sa');
  assert.equal((await api.call('POST', `/api/walkins/${other.id}/dismiss`, GYM_DESK)).status, 404);
  assert.equal((await api.call('POST', `/api/walkins/${other.id}/dismiss`, DESK)).status, 200);
  assert.equal((await api.call('POST', `/api/walkins/${other.id}/dismiss`, DESK)).status, 409);
  assert.equal((await api.call('GET', '/api/walkins', DESK)).body.walkins.length, 2);
  // Audit: ids only.
  const audit = JSON.stringify((await api.call('GET', '/api/audit?limit=40', OWNER)).body);
  assert.match(audit, /walkin\.create/);
  assert.match(audit, /walkin\.issue/);
  assert.equal(/Walter|Pipes/.test(audit), false);
});

test('kiosk sign-out ends the visit and its codes; walk-ins per kiosk are capped', async t => {
  const { api } = await setup(t);
  const k = await pair(api);
  const v = await visitToday(api);
  assert.equal((await kiosk(api, { kiosk: k.key, action: 'checkout', email: 'nobody@guest.example' })).status, 404);
  const out = await kiosk(api, { kiosk: k.key, action: 'checkout', email: 'vera@guest.example' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const visit = (await api.call('GET', '/api/visits', OWNER)).body.visits.find(x => x.id === v.body.visit.id);
  assert.equal(visit.status, 'checked_out');
  assert.equal(visit.endedBy, `kiosk:${k.id}`);
  assert.ok(visit.codes.every(c => c.status !== 'active'));
  assert.equal((await kiosk(api, { kiosk: k.key, action: 'checkout', email: 'vera@guest.example' })).status, 404, 'already gone');

  let last;
  for (let i = 0; i < 31; i++) last = await kiosk(api, { kiosk: k.key, action: 'walkin', name: `Guest ${i}` });
  assert.equal(last.status, 429);
});

test('walk-in details follow visitor retention and erasure; the demo reset clears walk-ins, keeps kiosks', async t => {
  const { api, sql } = await setup(t, { PLATFORM_TOKEN: 'platform-token-for-kiosk-tests-0123456789' });
  const k = await pair(api);
  await kiosk(api, { kiosk: k.key, action: 'walkin', name: 'Old Guest', company: 'Past Co' });
  await kiosk(api, { kiosk: k.key, action: 'walkin', name: 'Yesterday Guest' });
  await kiosk(api, { kiosk: k.key, action: 'walkin', name: 'Linked Guest' });
  sql.prepare("UPDATE walkins SET created_at = '2000-01-01T00:00:00.000Z' WHERE visitor_name = 'Old Guest'").run();
  sql.prepare('UPDATE walkins SET created_at = ? WHERE visitor_name = ?').run(new Date(Date.now() - 30 * 3600e3).toISOString(), 'Yesterday Guest');
  await api.server.api.maintainOne('t_default');
  const rows = Object.fromEntries(sql.prepare('SELECT id, visitor_name, company, status, erased_at FROM walkins').all().map(r => [r.id, r]));
  const old = Object.values(rows).find(r => r.erased_at);
  assert.equal(old.visitor_name, null);
  assert.equal(old.company, null);
  assert.equal(Object.values(rows).find(r => r.visitor_name === 'Yesterday Guest').status, 'expired');

  const linked = Object.values(rows).find(r => r.visitor_name === 'Linked Guest');
  const v = await api.call('POST', '/api/visits', { ...OWNER, body: { visitorName: 'Linked Guest', hostUserId: 'u1', lockIds: [9001], endLocal: londonAt(3), walkinId: linked.id } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await api.call('POST', `/api/visits/${v.body.visit.id}/erase`, OWNER)).status, 200);
  assert.equal(sql.prepare('SELECT visitor_name FROM walkins WHERE id = ?').get(linked.id).visitor_name, null, 'erasing the visit erases the walk-in');

  const reset = await api.call('POST', '/api/platform/tenants/t_default/demo-reset', { token: 'platform-token-for-kiosk-tests-0123456789', body: { confirm: 't_default' } });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM walkins').get().n, 0);
  assert.equal((await kiosk(api, { kiosk: k.key, action: 'info' })).status, 200, 'the paired tablet keeps working');
});

test('Turnstile on signup: optional, verified server-side, fails closed; CSP widened on /signup only', async t => {
  const seen = [];
  let status = 200;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { const j = JSON.parse(b || '{}'); seen.push(j); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: j.response === 'good-token', 'error-codes': j.response === 'good-token' ? [] : ['invalid-input-response'] })); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const { api } = await setup(t, { SIGNUP_ENABLED: '1', TURNSTILE_SITE_KEY: '0x4AAAAAAAsite', TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecret', TURNSTILE_VERIFY_URL: `http://127.0.0.1:${srv.address().port}/siteverify` });
  const post = body => fetch(`${api.base}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  const form = { company: 'Harbour', name: 'Maya', email: 'maya@harbour.example', timeZone: 'Europe/London', acceptTerms: true };
  assert.equal((await api.call('GET', '/api/signup')).body.turnstileSiteKey, '0x4AAAAAAAsite');
  assert.equal((await post(form)).status, 400, 'no token');
  assert.equal(seen.length, 0, 'no call without a token');
  const bad = await post({ ...form, turnstileToken: 'bad-token' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.retryHumanCheck, true);
  assert.equal((await post({ ...form, turnstileToken: 'good-token' })).status, 200);
  assert.equal(seen.at(-1).secret, '0x4AAAAAAAsecret');
  assert.equal(seen.at(-1).response, 'good-token');
  status = 500;
  assert.equal((await post({ ...form, turnstileToken: 'good-token' })).status, 503, 'fails closed');

  const csp = async p => (await fetch(`${api.base}${p}`)).headers.get('content-security-policy');
  assert.match(await csp('/signup'), /script-src 'self' https:\/\/challenges\.cloudflare\.com;.*frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.equal((await csp('/')).includes('challenges.cloudflare.com'), false);
  assert.equal((await csp('/kiosk')).includes('challenges.cloudflare.com'), false);
});

test('doctor: Turnstile needs both keys; test keys are flagged; open signup without it is a warning', () => {
  const { checkConfig } = require('../doctor-core');
  const f = env => checkConfig({ ADMIN_TOKEN: 'owner-token', SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'), PUBLIC_URL: 'https://doors.example', ...env }, { production: true })
    .filter(x => /^TURNSTILE/.test(x.id)).map(x => `${x.level}:${x.id}`).sort();
  assert.deepEqual(f({}), []);
  assert.deepEqual(f({ SIGNUP_ENABLED: '1', EMAIL_PROVIDER: 'resend' }), ['warn:TURNSTILE_SITE_KEY']);
  assert.deepEqual(f({ TURNSTILE_SITE_KEY: '0x4AAAAAAAsite' }), ['error:TURNSTILE_SECRET_KEY']);
  assert.deepEqual(f({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }), ['error:TURNSTILE_SITE_KEY']);
  assert.deepEqual(f({ TURNSTILE_SITE_KEY: '0x4AAAAAAAsite', TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecret' }), ['ok:TURNSTILE_SITE_KEY']);
});

test('QR encoder: output matches the recorded, externally verified matrices', () => {
  const h = text => crypto.createHash('sha256').update(qr.matrix(text).map(r => r.map(b => (b ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16);
  const m = qr.matrix('https://doors.example/kiosk#k=kx_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
  assert.equal(m.length, 4 * 5 + 17, 'version 5 for a pairing link');
  // Finder pattern corners: 7x7 dark ring, light ring, dark 3x3 centre.
  for (const [x, y] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]]) {
    assert.equal(m[y][x] && m[y + 6][x + 6] && m[y + 3][x + 3] && !m[y + 1][x + 1], true);
  }
  assert.equal(m[m.length - 8][8], true, 'the dark module');
  assert.throws(() => qr.matrix('x'.repeat(214)), /too long/);
  assert.match(qr.svg('hello'), /^<svg [^>]*viewBox="0 0 29 29"/);
  assert.deepEqual({
    a: h('HELLO WORLD'),
    b: h('https://doors.example/kiosk#k=kx_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'),
    c: h(`https://doors.example.com/kiosk#p=p1.t_default.ksk_abc123.1790000000.${'0123456789abcdef'.repeat(4)}`),
    d: h('Café – ünïcode ✓'),
  }, GOLDEN);
});
// Recorded after checking the encoder two ways: bit-identical to the Python `qrcode`
// reference for all 8 masks, and decoded by OpenCV's QRCodeDetector (versions 1-10).
const GOLDEN = { a: '2d21897bf5a7ac60', b: 'e34575641d458cbf', c: '12bf709a11c176e0', d: '09a0ec77e97f39fe' };
