// R17 calendar → visitor pre-registration (docs/23-CALENDAR.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot } = require('../support/boot');
const { sha256Hex } = require('../audit-core');
const cal = require('../calendar-core');
const policy = require('../policy-core');

const OWNER = { token: 'owner-token' };
const DESK = { token: 'desk-token' };
const DOMAIN = 'in.doors.example';
const SECRET = 'calendar-inbound-secret-0123456789';
const OPERATORS = JSON.stringify([{ id: 'op_desk', name: 'Reception', role: 'r_front_desk', siteIds: ['site_river'], tokenSha256: sha256Hex('desk-token') }]);
const CRLF = s => s.replace(/\r?\n/g, '\r\n');

/** London calendar date `days` ahead as YYYYMMDD. */
const londonDay = days => policy.localParts(new Date(Date.now() + days * 864e5), 'Europe/London').isoDate.replace(/-/g, '');
const londonUtc = (ymd, hm) => policy.zonedTimeToDate(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}T${hm}`, 'Europe/London').toISOString();

function ics({ uid = 'kickoff-1@google.com', seq = 0, method = 'REQUEST', day = londonDay(3), start = '100000', end = '113000', organizer = 'sarah@acme.co.uk', inbox = 'cal-x@in.doors.example', extra = '', guests = null, tz = 'TZID=Europe/London' }) {
  const g = guests || [
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Vera Visitorova;X-NUM-GUESTS=0:mailto:vera@guest.example',
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${inbox}:mailto:${inbox}`,
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Sarah Kelly:mailto:sarah@acme.co.uk',
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Dev Patel:mailto:dev@acme.co.uk',
    'ATTENDEE;CUTYPE=RESOURCE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Boardroom (8):mailto:c_1889@resource.calendar.google.com',
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED;CN=No Show:mailto:noshow@guest.example',
    // Folded (RFC 5545 §3.1): a CRLF followed by one space continues the line.
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Paul Pa\r\n rtner:mailto:paul@partner.example',
  ];
  return CRLF([
    'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    'BEGIN:VEVENT', `DTSTART;${tz}:${day}T${start}`, `DTEND;${tz}:${day}T${end}`, 'DTSTAMP:20260927T080000Z',
    `ORGANIZER;CN=Sarah Kelly:mailto:${organizer}`, `UID:${uid}`, ...g, extra,
    'SUMMARY:Audit kickoff\\, phase 1', 'LOCATION:Riverside Office\\, 3rd floor', `SEQUENCE:${seq}`, `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR', ''].filter(x => x !== '').join('\n'));
}
/** What Google Calendar sends: multipart/mixed → alternative (text, text/calendar 7bit) + invite.ics (base64). */
const googleEmail = (to, body) => CRLF(`From: Sarah Kelly <sarah@acme.co.uk>
To: ${to}
Subject: Invitation: Audit kickoff
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="000000000000mixed"

--000000000000mixed
Content-Type: multipart/alternative; boundary="000000000000alt"

--000000000000alt
Content-Type: text/plain; charset="UTF-8"

You have been invited to the following event.
--000000000000alt
Content-Type: text/calendar; charset="UTF-8"; method=REQUEST
Content-Transfer-Encoding: 7bit

${body}
--000000000000alt--

--000000000000mixed
Content-Type: application/ics; name="invite.ics"
Content-Disposition: attachment; filename="invite.ics"
Content-Transfer-Encoding: base64

${Buffer.from(body).toString('base64').replace(/(.{76})/g, '$1\n')}
--000000000000mixed--
`);
/** What Outlook / Exchange sends: a base64 text/calendar with a Windows zone name and its VTIMEZONE. */
const outlookEmail = (to, day) => {
  const body = CRLF(`BEGIN:VCALENDAR
METHOD:REQUEST
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VTIMEZONE
TZID:GMT Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T010000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
ORGANIZER;CN=Sarah Kelly:mailto:SARAH@acme.co.uk
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Vera Visitorova:mailto:vera@guest.example
ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${to}:mailto:${to}
UID:040000008200E00074C5B7101A82E00800000000A0E1
SUMMARY;LANGUAGE=en-GB:Supplier visit
DTSTART;TZID=GMT Standard Time:${day}T140000
DTEND;TZID=GMT Standard Time:${day}T150000
SEQUENCE:0
END:VEVENT
END:VCALENDAR
`);
  return CRLF(`From: Sarah Kelly <sarah@acme.co.uk>
To: ${to}
Subject: Supplier visit
Content-Type: text/calendar; charset="utf-8"; method=REQUEST
Content-Transfer-Encoding: base64

${Buffer.from(body).toString('base64').replace(/(.{76})/g, '$1\n')}
`);
};
const USERS = [{ id: 'u1', name: 'Sarah Kelly', email: 'sarah@acme.co.uk' }, { id: 'u2', name: 'Dev Patel', email: 'dev@acme.co.uk' }, { id: 'u5', name: 'Ex', email: 'ex@acme.co.uk', suspended: true }];
const read = (body, extra = {}) => cal.readInvitation(body, { users: USERS, inbox: 'cal-x@in.doors.example', fallbackTz: 'Europe/London', ...extra });

test('parser: Google invitation (multipart, 7bit + base64 attachment, folded lines, rooms, colleagues, declined)', () => {
  const day = londonDay(3);
  const mail = cal.calendarsFromEmail(Buffer.from(googleEmail('cal-x@in.doors.example', ics({ day }))));
  assert.equal(mail.calendars.length, 2, 'the inline part and the attachment');
  assert.equal(mail.calendars[1], mail.calendars[0].replace(/\r?\n$/, '') + (mail.calendars[1].endsWith('\r\n') ? '\r\n' : ''), 'base64 attachment decodes to the same text');
  const r = read(mail.calendars[0]);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.hostUserId, 'u1');
  assert.equal(r.startAt, londonUtc(day, '10:00'));
  assert.equal(r.endAt, londonUtc(day, '11:30'));
  assert.equal(r.summary, 'Audit kickoff, phase 1');
  assert.equal(r.location, 'Riverside Office, 3rd floor');
  assert.deepEqual(r.guests, [{ email: 'vera@guest.example', name: 'Vera Visitorova' }, { email: 'paul@partner.example', name: 'Paul Partner' }],
    'not: the organiser, the calendar address, a colleague, the room, the declined guest');
  assert.equal(r.tzAssumed, false);
  // Colleagues on a verified company domain are skipped even if not (yet) in AccessX.
  assert.deepEqual(read(mail.calendars[0], { internalDomains: ['partner.example'] }).guests.map(g => g.email), ['vera@guest.example']);
});

test('parser: Outlook (base64, Windows zone name), unknown zone via VTIMEZONE rules, floating time, DURATION, quoted-printable', () => {
  const day = londonDay(4);
  const mail = cal.calendarsFromEmail(outlookEmail('cal-x@in.doors.example', day));
  const r = read(mail.calendars[0]);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.hostUserId, 'u1', 'organiser matched case-insensitively');
  assert.equal(r.startAt, londonUtc(day, '14:00'));
  assert.deepEqual(r.guests.map(g => g.email), ['vera@guest.example']);
  // A zone name we do not know: its VTIMEZONE rules decide (summer and winter).
  const custom = mail.calendars[0].replace(/GMT Standard Time/g, 'Custom Zone Name');
  const summer = read(custom.replace(new RegExp(day, 'g'), '20270715'), { now: Date.parse('2027-07-01T00:00:00Z') });
  assert.equal(summer.startAt, '2027-07-15T13:00:00.000Z', 'BST: 14:00 = 13:00Z');
  assert.equal(summer.tzAssumed, false);
  const winter = read(custom.replace(new RegExp(day, 'g'), '20271215'), { now: Date.parse('2027-12-01T00:00:00Z') });
  assert.equal(winter.startAt, '2027-12-15T14:00:00.000Z', 'GMT: 14:00 = 14:00Z');
  // Floating time (no zone at all): the office zone, flagged for the organiser.
  const floating = read(ics({ day, tz: 'VALUE=DATE-TIME' }), { fallbackTz: 'Australia/Sydney' });
  assert.equal(floating.tzAssumed, true);
  assert.equal(floating.startAt, policy.zonedTimeToDate(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T10:00`, 'Australia/Sydney').toISOString());
  // DURATION instead of DTEND.
  const dur = read(ics({ day }).replace(/DTEND[^\r\n]*\r\n/, 'DURATION:PT45M\r\n'));
  assert.equal(Date.parse(dur.endAt) - Date.parse(dur.startAt), 45 * 60e3);
  // Quoted-printable transfer encoding (some gateways re-encode).
  const qp = CRLF(`Content-Type: text/calendar; method=REQUEST\nContent-Transfer-Encoding: quoted-printable\n\n${ics({ day }).replace(/=/g, '=3D').replace(/(.{70})/g, '$1=\n')}`);
  assert.equal(read(cal.calendarsFromEmail(qp).calendars[0]).guests.length, 2);
});

test('parser: what is refused, and why (shown to admins, never to the sender)', () => {
  const day = londonDay(3);
  assert.match(read(ics({ day, organizer: 'mallory@evil.example' })).reason, /organiser is not an active person/);
  assert.match(read(ics({ day, organizer: 'ex@acme.co.uk' })).reason, /organiser is not an active person/, 'suspended');
  assert.match(read(ics({ day }).replace(/DTSTART[^\r\n]*/, `DTSTART;VALUE=DATE:${day}`).replace(/DTEND[^\r\n]*/, `DTEND;VALUE=DATE:${day}`)).reason, /all-day/);
  assert.match(read(ics({ day: londonDay(45) })).reason, /more than 30 days away/);
  assert.match(read(ics({ day: londonDay(-2) })).reason, /already over/);
  assert.match(read(ics({ day, guests: ['ATTENDEE;CN=Dev:mailto:dev@acme.co.uk'] })).reason, /no external guests/);
  assert.match(read(ics({ day, method: 'REPLY' })).reason, /ignored: reply/);
  const c = read(ics({ day, method: 'CANCEL' }));
  assert.equal(c.ok, true);
  assert.equal(c.method, 'CANCEL');
  assert.equal(cal.keyFromAddress('Cal-ABCDEFGHIJKLMNOP@In.Doors.Example', DOMAIN), 'abcdefghijklmnop');
  assert.equal(cal.keyFromAddress('cal-abcdefghijklmnop@other.example', DOMAIN), null);
  assert.equal(cal.keyFromAddress('cal-short@in.doors.example', DOMAIN), null);
  assert.deepEqual(cal.calendarsFromEmail('x'.repeat(600 * 1024)), { error: 'too large' });
});

/* ---------------- API ---------------- */

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
    EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'desk@accessx.example', EMAIL_API_BASE: mail.base, PUBLIC_URL: 'https://doors.example',
    CALENDAR_INBOUND_DOMAIN: DOMAIN, CALENDAR_INBOUND_SECRET: SECRET, ...env });
  t.after(api.close);
  return { api, mail, sql: api.server.store.sql.raw };
}
const inbound = (api, to, raw, secret = SECRET) => fetch(`${api.base}/api/inbound/calendar`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'x-envelope-to': to, 'content-type': 'message/rfc822' }, body: raw })
  .then(async r => ({ status: r.status, body: await r.json() }));
const confirm = (api, body) => fetch(`${api.base}/api/calendar-confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));
const linkIn = (mail, re) => { const m = mail.text.match(re); assert.ok(m, mail.text); return m[1]; };

async function configured(t) {
  const s = await setup(t);
  const off = await s.api.call('GET', '/api/calendar', OWNER);
  assert.deepEqual([off.body.available, off.body.inbox], [true, null]);
  assert.equal((await s.api.call('PUT', '/api/calendar', { ...DESK, body: { doorSets: [{ siteId: 'site_river', lockIds: [9001] }] } })).status, 403, 'owner only');
  assert.equal((await s.api.call('POST', '/api/doorGroups', { ...OWNER, body: { name: 'Server room', siteId: 'site_river', lockIds: [9002], sensitive: true } })).status, 200);
  assert.equal((await s.api.call('PUT', '/api/calendar', { ...OWNER, body: { doorSets: [{ siteId: 'site_river', lockIds: [9002] }] } })).status, 400, 'sensitive door');
  assert.equal((await s.api.call('PUT', '/api/calendar', { ...OWNER, body: { doorSets: [{ siteId: 'site_river', lockIds: [9101] }] } })).status, 400, 'door at another site');
  const put = await s.api.call('PUT', '/api/calendar', { ...OWNER, body: { doorSets: [{ siteId: 'site_river', lockIds: [9001, 9003] }, { siteId: 'site_gym', lockIds: [9101] }] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.match(put.body.inbox.address, /^cal-[a-z2-7]{16}@in\.doors\.example$/);
  return { ...s, address: put.body.inbox.address };
}

test('calendar → draft → organiser confirms → normal invitation → visitor registers → code (on the owner\'s standing approval)', async t => {
  const { api, mail, sql, address } = await configured(t);
  const day = londonDay(3);
  // Wrong secret / unknown address / not an invitation: nothing stored, nothing sent.
  assert.equal((await inbound(api, address, googleEmail(address, ics({ day, inbox: address })), 'wrong')).status, 404);
  assert.equal((await inbound(api, 'cal-aaaaaaaaaaaaaaaa@in.doors.example', googleEmail(address, ics({ day })))).body.accepted, false);
  assert.equal((await inbound(api, address, CRLF('Subject: hi\n\nplain text'))).body.accepted, false);
  assert.equal(mail.got.length, 0);

  const r = await inbound(api, address, googleEmail(address, ics({ day, inbox: address })));
  assert.deepEqual([r.status, r.body.accepted], [202, true]);
  assert.equal(mail.got.length, 1);
  assert.deepEqual(mail.got[0].to, ['sarah@acme.co.uk'], 'only the organiser, at the address AccessX has for them');
  assert.match(mail.got[0].subject, /Visitor access for "Audit kickoff, phase 1": please confirm/);
  assert.match(mail.got[0].text, /vera@guest\.example/);
  const token = linkIn(mail.got[0], /https:\/\/doors\.example\/calendar#t=([A-Za-z0-9_-]+)/);
  // A repeat delivery of the same invitation (Google re-sends on RSVPs) changes nothing.
  await inbound(api, address, googleEmail(address, ics({ day, inbox: address })));
  assert.equal(mail.got.length, 1);

  const list = await api.call('GET', '/api/calendar', OWNER);
  assert.equal(list.body.drafts[0].status, 'pending');
  assert.equal(list.body.drafts[0].guests.length, 2);
  const audit = JSON.stringify((await api.call('GET', '/api/audit?limit=10', OWNER)).body);
  assert.match(audit, /calendar\.draft/);
  assert.equal(/vera|partner\.example|Audit kickoff/i.test(audit), false, 'ids only in the audit chain');

  const info = await confirm(api, { token, action: 'info' });
  assert.equal(info.status, 200, JSON.stringify(info.body));
  assert.equal(info.body.suggestedSiteId, 'site_river', 'from LOCATION');
  assert.deepEqual(info.body.offices.map(o => o.siteId), ['site_river', 'site_gym']);
  assert.equal(info.body.host, 'Sarah');
  assert.equal((await confirm(api, { token, action: 'confirm', siteId: 'site_river', guests: ['nobody@else.example'] })).status, 400, 'only guests on the invitation');
  assert.equal((await confirm(api, { token, action: 'confirm', siteId: 'site_store', guests: ['vera@guest.example'] })).status, 400, 'only offered offices');
  const ok = await confirm(api, { token, action: 'confirm', siteId: 'site_river', guests: ['vera@guest.example'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.sent, [{ email: 'vera@guest.example' }]);
  assert.equal((await confirm(api, { token, action: 'confirm', siteId: 'site_river', guests: ['vera@guest.example'] })).status, 404, 'one use');
  assert.equal((await confirm(api, { token, action: 'info' })).status, 404);

  const inv = sql.prepare("SELECT * FROM visit_invites WHERE contact = 'vera@guest.example'").get();
  assert.equal(inv.created_by, 'owner', 'the configuring owner\'s approval');
  assert.deepEqual(JSON.parse(inv.lock_ids), [9001, 9003]);
  assert.equal(inv.start_local, `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T10:00`);
  assert.match(JSON.stringify((await api.call('GET', '/api/audit?limit=10', OWNER)).body), /"actor":"calendar:cal_/);
  // The visitor gets the ordinary invitation, registers, and the code goes to their address only.
  const toVera = mail.got.find(m => m.to[0] === 'vera@guest.example');
  const inviteToken = linkIn(toVera, /\/invite#([A-Za-z0-9_-]+)/);
  const sub = await fetch(`${api.base}/api/visit-invite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: inviteToken, action: 'submit', name: 'Vera Visitorova' }) }).then(x => x.json());
  assert.equal(sub.ok, true, JSON.stringify(sub));
  // Riverside has a sensitive door group, so (as for any invitation there) reception approves first.
  assert.equal(sub.pending, true);
  assert.equal(mail.got.some(m => /door code/i.test(m.subject)), false);
  const approve = await api.call('POST', `/api/visit-invites/${inv.id}/approve`, DESK);
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.ok(mail.got.some(m => m.to[0] === 'vera@guest.example' && /door code/i.test(m.subject)), JSON.stringify(mail.got.map(m => [m.to, m.subject])));
});

test('meeting moved → new confirmation, old unused invitations withdrawn; meeting cancelled → withdrawn; paused if the owner loses the right', async t => {
  const { api, mail, sql, address } = await configured(t);
  const day = londonDay(3);
  await inbound(api, address, googleEmail(address, ics({ day, inbox: address })));
  const t1 = linkIn(mail.got.at(-1), /calendar#t=([A-Za-z0-9_-]+)/);
  await confirm(api, { token: t1, action: 'confirm', siteId: 'site_river', guests: ['vera@guest.example', 'paul@partner.example'] });
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM visit_invites WHERE status = 'open'").get().n, 2);
  // An older SEQUENCE arriving late is ignored; the move (SEQUENCE 1) needs a new confirmation.
  const before = mail.got.length;
  await inbound(api, address, googleEmail(address, ics({ day, seq: 1, start: '140000', end: '150000', inbox: address })));
  assert.equal(mail.got.length, before + 1);
  const t2 = linkIn(mail.got.at(-1), /calendar#t=([A-Za-z0-9_-]+)/);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM visit_invites WHERE status = 'open'").get().n, 2, 'nothing changes until the organiser confirms');
  const moved = await confirm(api, { token: t2, action: 'confirm', siteId: 'site_river', guests: ['vera@guest.example'] });
  assert.equal(moved.status, 200);
  const rows = sql.prepare('SELECT status, start_local FROM visit_invites ORDER BY created_at').all();
  assert.deepEqual(rows.map(r => r.status), ['revoked', 'revoked', 'open']);
  assert.match(rows[2].start_local, /T14:00$/);
  // Cancelled: the unused invitation is withdrawn.
  await inbound(api, address, googleEmail(address, ics({ day, seq: 2, method: 'CANCEL', inbox: address })));
  assert.deepEqual(sql.prepare('SELECT status FROM visit_invites ORDER BY created_at').all().map(r => r.status), ['revoked', 'revoked', 'revoked']);
  assert.equal((await api.call('GET', '/api/calendar', OWNER)).body.drafts.find(d => d.status === 'cancelled').inviteIds.length, 1);

  // A forged invitation (organiser not in AccessX): stored as unusable for admins, no email to anyone.
  const n = mail.got.length;
  await inbound(api, address, googleEmail(address, ics({ uid: 'forged@x', day, organizer: 'mallory@evil.example', inbox: address })));
  assert.equal(mail.got.length, n);
  assert.match((await api.call('GET', '/api/calendar', OWNER)).body.drafts[0].reason, /organiser is not an active person/);

  // The configuring operator no longer manages visitors: confirmations pause (409), nothing is issued.
  await inbound(api, address, googleEmail(address, ics({ uid: 'later@google.com', day, inbox: address })));
  const t3 = linkIn(mail.got.at(-1), /calendar#t=([A-Za-z0-9_-]+)/);
  sql.prepare("UPDATE calendar_inboxes SET configured_by = 'op_gone'").run();
  const paused = await confirm(api, { token: t3, action: 'confirm', siteId: 'site_river', guests: ['vera@guest.example'] });
  assert.equal(paused.status, 409);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM visit_invites WHERE status = 'open'").get().n, 0);
  assert.equal((await confirm(api, { token: t3, action: 'decline' })).body.declined, true, 'the organiser can still say no');

  // Rotating the address: the old one stops working.
  const rot = await api.call('POST', '/api/calendar/rotate', OWNER);
  assert.notEqual(rot.body.inbox.address, address);
  assert.equal((await inbound(api, address, googleEmail(address, ics({ uid: 'x2@google.com', day, inbox: address })))).body.accepted, false);
});

test('retention: unconfirmed drafts die with the meeting; guests\' addresses are erased after the visitor retention period', async t => {
  const { api, mail, sql, address } = await configured(t);
  await inbound(api, address, outlookEmail(address, londonDay(2)));
  assert.equal(mail.got.length, 1);
  const token = linkIn(mail.got[0], /calendar#t=([A-Za-z0-9_-]+)/);
  sql.prepare("UPDATE calendar_drafts SET end_at = '2000-01-01T00:00:00.000Z', created_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await confirm(api, { token, action: 'info' })).status, 404, 'past meetings cannot be confirmed');
  await api.server.api.maintainOne('t_default');
  const row = sql.prepare('SELECT status, guests, summary, token_sha256, erased_at FROM calendar_drafts').get();
  assert.deepEqual([row.status, row.guests, row.summary, row.token_sha256], ['expired', null, null, null]);
  assert.ok(row.erased_at);
});

test('calendar is off without CALENDAR_INBOUND_DOMAIN (and says what is missing)', async t => {
  const { api } = await setup(t, { CALENDAR_INBOUND_DOMAIN: '' });
  const g = await api.call('GET', '/api/calendar', OWNER);
  assert.equal(g.body.available, false);
  assert.deepEqual(g.body.missing, ['CALENDAR_INBOUND_DOMAIN']);
  assert.equal((await api.call('PUT', '/api/calendar', { ...OWNER, body: { doorSets: [{ siteId: 'site_river', lockIds: [9001] }] } })).status, 400);
  assert.equal((await inbound(api, 'cal-aaaaaaaaaaaaaaaa@in.doors.example', 'x')).body.accepted, false);
});
