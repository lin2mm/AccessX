'use strict';
/**
 * R17 calendar → visitor pre-registration (docs/23-CALENDAR.md).
 *
 * A host adds the tenant's calendar address (cal-<key>@<CALENDAR_INBOUND_DOMAIN>)
 * as a guest to a meeting. Google Calendar and Outlook / Exchange then email it
 * an iCalendar invitation (RFC 5545 / iTIP RFC 5546). This module turns that
 * email into a *draft*: who organised it, when, and which guests are external.
 * Nothing here grants access: the draft goes to the organiser's registered
 * address for confirmation, and confirmed guests get the normal invitation link.
 *
 * Pure functions, no dependencies (runs on Node and Workers).
 */
const policy = require('./policy-core');

const LIMITS = { rawBytes: 512 * 1024, parts: 50, depth: 5, attendees: 20, summary: 120, dayMs: 864e5 };
const KEY_RE = /^cal-([a-z2-7]{16})$/;

/* ---------------- MIME ---------------- */

/** Bytes (Uint8Array/Buffer) or string → a "binary" string (one char per byte). */
function toBinary(raw) {
  if (typeof raw === 'string') return raw;
  let s = '';
  for (let i = 0; i < raw.length; i += 8192) s += String.fromCharCode.apply(null, raw.subarray ? raw.subarray(i, i + 8192) : raw.slice(i, i + 8192));
  return s;
}
function binaryToBytes(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
function decodeText(binary, charset) {
  const bytes = binaryToBytes(binary);
  try { return new TextDecoder(/^(utf-?8|us-ascii|ascii)?$/i.test(charset || '') ? 'utf-8' : charset, { fatal: false }).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}
function splitHead(s) {
  const m = s.match(/\r?\n\r?\n/);
  if (!m) return { head: s, body: '' };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}
function parseHeaders(head) {
  const out = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in out)) out[k] = line.slice(i + 1).trim(); }
  }
  return out;
}
/** `text/calendar; method=REQUEST; charset="utf-8"` → { type, params }. */
function parseParams(value) {
  const [type, ...rest] = String(value || '').split(';');
  const params = {};
  for (const p of rest) {
    const m = p.match(/^\s*([\w.-]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) params[m[1].toLowerCase()] = m[2];
  }
  return { type: type.trim().toLowerCase(), params };
}
function decodeTransfer(body, enc) {
  enc = String(enc || '').toLowerCase();
  if (enc === 'base64') {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, '');
    if (typeof atob === 'function') { try { return atob(clean); } catch { return ''; } }
    return Buffer.from(clean, 'base64').toString('latin1');
  }
  if (enc === 'quoted-printable') {
    return body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

/**
 * Every iCalendar body in an email: text/calendar parts and .ics attachments
 * (application/ics, application/octet-stream named *.ics), at any depth.
 */
function calendarsFromEmail(raw) {
  const s = toBinary(raw);
  if (s.length > LIMITS.rawBytes) return { error: 'too large' };
  const found = [];
  let parts = 0;
  const walk = (entity, depth) => {
    if (++parts > LIMITS.parts || depth > LIMITS.depth) return;
    const { head, body } = splitHead(entity);
    const h = parseHeaders(head);
    const ct = parseParams(h['content-type'] || 'text/plain');
    if (ct.type.startsWith('multipart/') && ct.params.boundary) {
      const b = `--${ct.params.boundary}`;
      const chunks = body.split(b).slice(1);
      for (const c of chunks) {
        if (c.startsWith('--')) break;
        walk(c.replace(/^\r?\n/, ''), depth + 1);
      }
      return;
    }
    const disp = parseParams(h['content-disposition'] || '');
    const name = ct.params.name || disp.params.filename || '';
    if (ct.type === 'text/calendar' || ct.type === 'application/ics' || /\.ics$/i.test(name)) {
      found.push(decodeText(decodeTransfer(body, h['content-transfer-encoding']), ct.params.charset));
    }
  };
  walk(s, 0);
  const top = parseHeaders(splitHead(s).head);
  return { calendars: found, subject: top.subject || '', from: top.from || '' };
}

/* ---------------- iCalendar ---------------- */

const unescape = v => v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
function parseLine(line) {
  // NAME;P1=a;P2="b:c":value — colons inside quoted params do not end the name.
  let i = 0; let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  const left = line.slice(0, i); const value = line.slice(i + 1);
  const bits = left.match(/(?:[^;"]+|"[^"]*")+/g) || [''];
  const params = {};
  for (const p of bits.slice(1)) { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); }
  return { name: bits[0].toUpperCase(), params, value };
}
/** → { method, events: [{props}], timezones: {TZID: component} }. Props: NAME → [{params, value}]. */
function parseIcs(text) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const root = { type: 'ROOT', props: {}, children: [] };
  const stack = [root];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const l = parseLine(raw);
    if (l.name === 'BEGIN') { const c = { type: l.value.trim().toUpperCase(), props: {}, children: [] }; stack[stack.length - 1].children.push(c); if (stack.length < 8) stack.push(c); continue; }
    if (l.name === 'END') { if (stack.length > 1) stack.pop(); continue; }
    const cur = stack[stack.length - 1];
    (cur.props[l.name] ||= []).push({ params: l.params, value: l.value });
  }
  const cal = root.children.find(c => c.type === 'VCALENDAR') || { props: {}, children: [] };
  const first = (c, n) => (c.props[n] && c.props[n][0]) || null;
  const timezones = {};
  for (const tz of cal.children.filter(c => c.type === 'VTIMEZONE')) { const id = first(tz, 'TZID'); if (id) timezones[id.value] = tz; }
  const m = first(cal, 'METHOD');
  return { method: m ? m.value.trim().toUpperCase() : null, events: cal.children.filter(c => c.type === 'VEVENT'), timezones, first };
}

/** Common Outlook / Exchange (Windows) zone names → IANA (CLDR windowsZones, territory 001). */
const WINDOWS_ZONES = {
  'UTC': 'Etc/UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest', 'Russian Standard Time': 'Europe/Moscow', 'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem', 'South Africa Standard Time': 'Africa/Johannesburg', 'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Calcutta', 'SE Asia Standard Time': 'Asia/Bangkok', 'Singapore Standard Time': 'Asia/Singapore',
  'China Standard Time': 'Asia/Shanghai', 'Taipei Standard Time': 'Asia/Taipei', 'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
  'W. Australia Standard Time': 'Australia/Perth', 'AUS Central Standard Time': 'Australia/Darwin', 'Cen. Australia Standard Time': 'Australia/Adelaide',
  'E. Australia Standard Time': 'Australia/Brisbane', 'AUS Eastern Standard Time': 'Australia/Sydney', 'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland', 'Hawaiian Standard Time': 'Pacific/Honolulu', 'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles', 'US Mountain Standard Time': 'America/Phoenix', 'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago', 'Central Standard Time (Mexico)': 'America/Mexico_City', 'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York', 'Atlantic Standard Time': 'America/Halifax', 'SA Pacific Standard Time': 'America/Bogota',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Buenos_Aires', 'Newfoundland Standard Time': 'America/St_Johns',
};

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;
const offsetOf = v => { const m = String(v || '').match(/^([+-])(\d{2})(\d{2})/); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60e3 : null; };
/** nth weekday of a month (n = -1 for last), at a wall-clock time, as a "local ms" value. */
function nthWeekday(year, month, byday, h, mi) {
  const m = String(byday).match(/^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/);
  if (!m) return null;
  const n = Number(m[1] || 1); const dow = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(m[2]);
  if (n > 0) { const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); return Date.UTC(year, month - 1, 1 + ((dow - first + 7) % 7) + (n - 1) * 7, h, mi); }
  const lastDay = new Date(Date.UTC(year, month, 0)); const back = (lastDay.getUTCDay() - dow + 7) % 7;
  return Date.UTC(year, month - 1, lastDay.getUTCDate() - back + (n + 1) * 7, h, mi);
}
/**
 * Offset from a VTIMEZONE's yearly STANDARD/DAYLIGHT rules (what Outlook sends for
 * zone names we do not know). Supports FREQ=YEARLY;BYMONTH;BYDAY and fixed zones.
 */
function vtimezoneOffset(tz, localMs, first) {
  const year = new Date(localMs).getUTCFullYear();
  const rules = [];
  for (const c of tz.children.filter(x => x.type === 'STANDARD' || x.type === 'DAYLIGHT')) {
    const to = offsetOf((first(c, 'TZOFFSETTO') || {}).value); const from = offsetOf((first(c, 'TZOFFSETFROM') || {}).value);
    const start = String((first(c, 'DTSTART') || {}).value || '').match(DT_RE);
    if (to === null || !start) continue;
    const rr = (first(c, 'RRULE') || {}).value || '';
    const bm = Number((rr.match(/BYMONTH=(\d+)/) || [])[1]); const bd = (rr.match(/BYDAY=([+-]?\d?[A-Z]{2})/) || [])[1];
    const h = Number(start[4] || 0); const mi = Number(start[5] || 0);
    for (const y of [year - 1, year]) {
      const at = bm && bd ? nthWeekday(y, bm, bd, h, mi) : (y === year ? Date.UTC(+start[1], +start[2] - 1, +start[3], h, mi) : null);
      if (at !== null) rules.push({ at: at - (from === null ? to : from), to }); // transition instant in UTC-ish local terms
    }
  }
  if (!rules.length) return null;
  const guess = localMs - rules[0].to;
  const past = rules.filter(r => r.at <= guess).sort((a, b) => b.at - a.at);
  return (past[0] || rules.sort((a, b) => a.at - b.at)[0]).to;
}

/**
 * DTSTART/DTEND property → { ms, allDay, tzAssumed }. Floating times and zones we
 * cannot resolve use `fallbackTz` (the site's zone) and say so.
 */
function toInstant(prop, timezones, first, fallbackTz) {
  if (!prop) return null;
  const m = String(prop.value).trim().match(DT_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, z] = m;
  if (prop.params.VALUE === 'DATE' || h === undefined) return { ms: Date.UTC(+y, +mo - 1, +d), allDay: true };
  const local = `${y}-${mo}-${d}T${h}:${mi}`;
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0)) };
  const tzid = prop.params.TZID ? prop.params.TZID.replace(/^\//, '') : null;
  const iana = tzid && (policy.isValidTimeZone(tzid) ? tzid : WINDOWS_ZONES[tzid]);
  if (iana && policy.isValidTimeZone(iana)) return { ms: policy.zonedTimeToDate(local, iana).getTime() };
  if (tzid && timezones[prop.params.TZID]) {
    const off = vtimezoneOffset(timezones[prop.params.TZID], Date.UTC(+y, +mo - 1, +d, +h, +mi), first);
    if (off !== null) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi) - off };
  }
  return { ms: policy.zonedTimeToDate(local, fallbackTz).getTime(), tzAssumed: true };
}
function durationMs(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 864e5 + +(m[4] || 0) * 3600e3 + +(m[5] || 0) * 60e3 + +(m[6] || 0) * 1e3);
}
const mailto = v => { const m = String(v || '').trim().match(/^mailto:(.+)$/i); return m ? m[1].trim().toLowerCase() : null; };
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;
const cleanText = (v, max) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * One invitation → what a draft needs, or { ok: false, reason } (shown to admins
 * in the "recently received" list; never sent back to the sender).
 *
 * users:           the tenant's people (organiser must be one, by email, active)
 * internalDomains: verified company domains: guests there are colleagues
 * inbox:           the calendar address itself (never a guest)
 */
function readInvitation(icsText, { users, internalDomains = [], inbox, fallbackTz, now = Date.now(), maxDaysAhead = 30 }) {
  const cal = parseIcs(icsText);
  const method = cal.method || 'REQUEST';
  if (!['REQUEST', 'CANCEL', 'PUBLISH'].includes(method)) return { ok: false, reason: `ignored: ${method.toLowerCase()} message` };
  // A recurring series: the master event (no RECURRENCE-ID); single changed occurrences are ignored.
  const ev = cal.events.find(e => !e.props['RECURRENCE-ID']) || cal.events[0];
  if (!ev) return { ok: false, reason: 'no event in the invitation' };
  const f = n => cal.first(ev, n);
  const uid = cleanText((f('UID') || {}).value, 300);
  if (!uid) return { ok: false, reason: 'invitation has no UID' };
  const sequence = Number((f('SEQUENCE') || {}).value || 0) || 0;
  const organizer = mailto((f('ORGANIZER') || {}).value);
  const host = organizer && users.find(u => !u.suspended && u.email && u.email.toLowerCase() === organizer);
  if (!host) return { ok: false, reason: 'the organiser is not an active person in AccessX (matched by email)', uid, method };
  const base = { uid, sequence, method, hostUserId: host.id };
  if (method === 'CANCEL' || /^CANCELLED$/i.test((f('STATUS') || {}).value || '')) return { ok: true, ...base, method: 'CANCEL' };

  const start = toInstant(f('DTSTART'), cal.timezones, cal.first, fallbackTz);
  if (!start) return { ok: false, reason: 'invitation has no start time', ...base };
  if (start.allDay) return { ok: false, reason: 'all-day events are not used for door access: give the meeting a start and end time', ...base };
  let end = toInstant(f('DTEND'), cal.timezones, cal.first, fallbackTz);
  if (!end && f('DURATION')) { const d = durationMs(f('DURATION').value); if (d !== null) end = { ms: start.ms + d }; }
  if (!end || end.allDay || end.ms <= start.ms) return { ok: false, reason: 'invitation has no valid end time', ...base };
  if (end.ms <= now) return { ok: false, reason: 'the meeting is already over', ...base };
  if (start.ms > now + maxDaysAhead * LIMITS.dayMs) return { ok: false, reason: `the meeting is more than ${maxDaysAhead} days away: invitations are sent at most ${maxDaysAhead} days ahead`, ...base };
  const recurring = Boolean(f('RRULE'));

  const staff = new Set(users.filter(u => u.email).map(u => u.email.toLowerCase()));
  const domains = new Set(internalDomains.map(d => d.toLowerCase()));
  const seen = new Set();
  const guests = [];
  for (const a of ev.props.ATTENDEE || []) {
    const email = mailto(a.value);
    if (!email || !EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    const cutype = String(a.params.CUTYPE || 'INDIVIDUAL').toUpperCase();
    if (cutype !== 'INDIVIDUAL' && cutype !== 'UNKNOWN') continue; // rooms, resources, groups
    if (email === organizer || email === String(inbox || '').toLowerCase() || staff.has(email) || domains.has(email.split('@')[1])) continue;
    if (/^DECLINED$/i.test(a.params.PARTSTAT || '')) continue;
    guests.push({ email, name: cleanText(a.params.CN && a.params.CN.toLowerCase() !== email ? a.params.CN : '', 100) || null });
    if (guests.length >= LIMITS.attendees) break;
  }
  if (!guests.length) return { ok: false, reason: 'no external guests on the invitation (colleagues, rooms and the calendar address are skipped)', ...base };
  return {
    ok: true, ...base, method: 'REQUEST',
    summary: cleanText(unescape((f('SUMMARY') || {}).value || ''), LIMITS.summary) || null,
    location: cleanText(unescape((f('LOCATION') || {}).value || ''), 200) || null,
    startAt: new Date(start.ms).toISOString(), endAt: new Date(end.ms).toISOString(),
    tzAssumed: Boolean(start.tzAssumed || end.tzAssumed), recurring, guests,
  };
}

/** `cal-<key>@domain` → key (lower-case base32, 80 bits), else null. */
function keyFromAddress(address, domain) {
  const m = String(address || '').trim().toLowerCase().match(/^([^@]+)@(.+)$/);
  if (!m || (domain && m[2] !== String(domain).toLowerCase())) return null;
  const k = m[1].match(KEY_RE);
  return k ? k[1] : null;
}
function newKey(randomBytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from(randomBytes(16), b => alphabet[b & 31]).join('');
}

module.exports = { LIMITS, WINDOWS_ZONES, calendarsFromEmail, parseIcs, readInvitation, toInstant, durationMs, keyFromAddress, newKey, vtimezoneOffset };
