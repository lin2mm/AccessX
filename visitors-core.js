/**
 * Visitors — shared by server.js and worker.js.
 * ====================================================================
 * A visit is an invitation: who, which host, which doors, which window.
 * Each door gets an ordinary TTLock period passcode whose validity IS the
 * visit window, so the lock enforces the end time itself — offline, even if
 * the cloud is down. Ending a visit early revokes the codes (gateway) or
 * reports honestly that a door without gateway keeps accepting the code
 * until its end time unless removed on site.
 *
 * Rules:
 *  - the host must be an active person the operator can see; visitor codes
 *    follow the host (credentials-core review revokes them if the host is
 *    suspended or removed);
 *  - no sensitive doors: those need a rule and four-eyes approval;
 *  - all doors at one site (one time zone for the window);
 *  - whole hours (TTLock), at most `maxHours` long, at most 30 days ahead;
 *  - personal data (name, email, company) never goes to the audit chain or
 *    to the lock vendor, and is erased `retentionDays` after the visit.
 */
const policy = require('./policy-core');
const creds = require('./credentials-core');
const { normalizePhone } = require('./sms-core');

const LIMITS = { maxDoors: 5, maxHours: 24, maxHoursCap: 168, aheadDays: 30, retentionDays: 30, retentionMin: 1, retentionMax: 365 };
const HOUR = 36e5;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function settingsOf(settings) {
  const v = (settings && settings.visitors) || {};
  const int = (x, lo, hi, dflt) => (Number.isInteger(x) && x >= lo && x <= hi ? x : dflt);
  return {
    maxHours: int(v.maxHours, 1, LIMITS.maxHoursCap, LIMITS.maxHours),
    retentionDays: int(v.retentionDays, LIMITS.retentionMin, LIMITS.retentionMax, LIMITS.retentionDays),
    notifyHost: v.notifyHost !== false, // email the host when their visitor first opens a door
  };
}

/** Validate a settings update; returns { ok, value } or { ok: false, error }. */
function validateSettings(body) {
  const out = {};
  if (body.maxHours !== undefined) {
    if (!Number.isInteger(body.maxHours) || body.maxHours < 1 || body.maxHours > LIMITS.maxHoursCap) return { ok: false, error: `maxHours must be a whole number from 1 to ${LIMITS.maxHoursCap}` };
    out.maxHours = body.maxHours;
  }
  if (body.retentionDays !== undefined) {
    if (!Number.isInteger(body.retentionDays) || body.retentionDays < LIMITS.retentionMin || body.retentionDays > LIMITS.retentionMax) return { ok: false, error: `retentionDays must be a whole number from ${LIMITS.retentionMin} to ${LIMITS.retentionMax}` };
    out.retentionDays = body.retentionDays;
  }
  if (body.notifyHost !== undefined) {
    if (typeof body.notifyHost !== 'boolean') return { ok: false, error: 'notifyHost must be true or false' };
    out.notifyHost = body.notifyHost;
  }
  return { ok: true, value: out };
}

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

/**
 * @returns {{ok:true, visit, timeZone, warnings}|{ok:false,status,error}}
 * `sensitive` = Set of sensitive lock ids; `canSeeLock(id)`, `canSeeUser(user)` = operator scope.
 */
function planVisit(snap, body, { now = Date.now(), sensitive = new Set(), canSeeLock = () => true, canSeeUser = () => true } = {}) {
  const visitorName = clean(body.visitorName, 100);
  if (!visitorName) return fail(400, 'visitorName is required');
  const visitorEmail = clean(body.visitorEmail, 200).toLowerCase() || null;
  if (visitorEmail && !EMAIL_RE.test(visitorEmail)) return fail(400, 'visitorEmail is not a valid address');
  const company = clean(body.company, 100) || null;
  const rawPhone = clean(body.visitorPhone, 30);
  const visitorPhone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !visitorPhone) return fail(400, 'visitorPhone must be an international number, e.g. +44 7700 900123');

  const host = (snap.users || []).find(u => u.id === body.hostUserId);
  if (!host || !canSeeUser(host)) return fail(404, 'unknown host');
  if (host.suspended) return fail(409, 'the host is suspended: visitor codes follow their host');

  const raw = Array.isArray(body.lockIds) ? body.lockIds : [];
  const lockIds = [...new Set(raw.map(Number))];
  if (!lockIds.length || lockIds.some(id => !Number.isFinite(id))) return fail(400, 'lockIds must list at least one door');
  if (lockIds.length > LIMITS.maxDoors) return fail(400, `a visit can include at most ${LIMITS.maxDoors} doors`);
  const hidden = lockIds.find(id => !canSeeLock(id));
  if (hidden !== undefined) return fail(403, `door ${hidden} is outside your sites`, { lockId: hidden });
  const secret = lockIds.find(id => sensitive.has(id));
  if (secret !== undefined) return fail(409, `door ${secret} is sensitive: visitors cannot get codes for it (give the person a rule, which needs a second operator's approval)`, { reason: 'sensitive_door', lockId: secret });
  const sites = new Set(lockIds.map(id => { const s = policy.siteForLock(snap, id); return s ? s.id : null; }));
  if (sites.size > 1) return fail(400, 'all doors of a visit must be at one site');
  const siteId = [...sites][0];
  const timeZone = policy.siteTimeZone(snap, siteId);

  const local = (v, name) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v || ''))) return { error: `${name} must look like 2026-10-05T09:00 (time at the door)` };
    const t = policy.zonedTimeToDate(String(v), timeZone).getTime();
    return Number.isFinite(t) ? { t } : { error: `${name} is not a valid time` };
  };
  let start = now;
  if (body.startLocal) { const s = local(body.startLocal, 'startLocal'); if (s.error) return fail(400, s.error); start = s.t; }
  const e = local(body.endLocal, 'endLocal');
  if (e.error) return fail(400, e.error);
  if (e.t <= start) return fail(400, 'the visit must end after it starts');
  if (start > now + LIMITS.aheadDays * 24 * HOUR) return fail(400, `visits can be registered at most ${LIMITS.aheadDays} days ahead`);
  const win = creds.ttlockWindow(start, e.t, timeZone);
  if (win.end <= now) return fail(400, 'this visit would already be over');
  const { maxHours } = settingsOf(snap.settings);
  if (win.end - win.start > maxHours * HOUR) return fail(400, `a visit can last at most ${maxHours} h (on whole hours: ${policy.localParts(new Date(win.start), timeZone).label} – ${policy.localParts(new Date(win.end), timeZone).label}); an owner can change this under Visitors → Settings`);

  return {
    ok: true,
    timeZone,
    warnings: creds.ttlockWarnings(win, timeZone, { explicitStart: Boolean(body.startLocal) }),
    host,
    visit: {
      visitorName, visitorEmail, visitorPhone, company, hostUserId: host.id, siteId, lockIds,
      startAt: new Date(win.start).toISOString(), endAt: new Date(win.end).toISOString(),
    },
  };
}

/** scheduled | active | ended | checked_out | cancelled */
function stateOf(visit, now = Date.now()) {
  if (visit.status === 'checked_out' || visit.status === 'cancelled') return visit.status;
  if (now < Date.parse(visit.startAt)) return 'scheduled';
  if (now < Date.parse(visit.endAt)) return 'active';
  return 'ended';
}

function rowToVisit(r) {
  return {
    id: r.id, visitorName: r.visitor_name, visitorEmail: r.visitor_email, visitorPhone: r.visitor_phone || null, company: r.company,
    hostUserId: r.host_user_id, siteId: r.site_id, lockIds: JSON.parse(r.lock_ids || '[]'),
    startAt: r.start_at, endAt: r.end_at, status: r.status, delivery: r.delivery,
    createdBy: r.created_by, createdAt: r.created_at, endedAt: r.ended_at, endedBy: r.ended_by,
    erased: Boolean(r.erased_at), erasedAt: r.erased_at,
    arrivedAt: r.arrived_at || null, arrivedLock: r.arrived_lock === null || r.arrived_lock === undefined ? null : Number(r.arrived_lock),
  };
}

/** Plain-text invitation with the codes. The codes are never stored; this is the only copy besides the screen. */
function invitationEmail({ visit, hostName, siteName, doors, timeZone, tenantName, checkoutUrl = null }) {
  const label = iso => policy.localParts(new Date(iso), timeZone).label;
  const long = Date.parse(visit.endAt) - Date.parse(visit.startAt) > 24 * HOUR;
  const lines = [
    `Hello ${visit.visitorName},`, '',
    `${hostName} has invited you to ${siteName || 'our building'}.`, '',
    doors.length > 1 ? 'Your door codes:' : 'Your door code:',
    ...doors.map(d => `  ${d.name}: ${d.code}`), '',
    `Valid from ${label(visit.startAt)} until ${label(visit.endAt)} (local time).`,
    'Type the code on the door keypad, then press the unlock key.',
    ...(long ? [`Please use it for the first time by ${label(new Date(Date.parse(visit.startAt) + 24 * HOUR).toISOString())}; the lock cancels codes that are not used within 24 hours of their start.`] : []),
    'The code stops working automatically at the end time, or earlier if your visit is ended.',
    'Please do not share it.', '',
    ...(checkoutUrl ? ['Leaving before the end time? Check out here and your code stops working:', checkoutUrl, ''] : []),
    '—', `${tenantName || 'AccessX'} · sent by AccessX`,
  ];
  return { subject: `Your door code for ${siteName || 'your visit'}`.slice(0, 200), text: lines.join('\n') };
}

/** SMS with the codes: short (one or two segments), no visitor name. */
function invitationSms({ visit, siteName, doors, timeZone, checkoutUrl = null }) {
  const label = iso => policy.localParts(new Date(iso), timeZone).label.replace(/ [A-Za-z_]+\/[A-Za-z_/]+$/, '');
  const long = Date.parse(visit.endAt) - Date.parse(visit.startAt) > 24 * HOUR;
  return [
    `${siteName || 'Your visit'}: door code${doors.length > 1 ? 's' : ''} ${doors.map(d => (doors.length > 1 ? `${d.name} ${d.code}` : d.code)).join(', ')}`,
    `valid ${label(visit.startAt)} to ${label(visit.endAt)} (local time).`,
    long ? `Use it first by ${label(new Date(Date.parse(visit.startAt) + 24 * HOUR).toISOString())}.` : '',
    'Enter it on the keypad, then the unlock key. Do not share.',
    checkoutUrl ? `Leaving? ${checkoutUrl}` : '',
  ].filter(Boolean).join(' ');
}

/** Host notification: "your visitor has arrived". */
function arrivalEmail({ visit, hostName, door, at, timeZone, tenantName }) {
  const who = visit.visitorName ? `${visit.visitorName}${visit.company ? ` (${visit.company})` : ''}` : 'Your visitor';
  const when = policy.localParts(new Date(at), timeZone).label;
  return {
    subject: `${who} has arrived`.slice(0, 200),
    text: [`Hello ${hostName || ''},`.replace(/ ,$/, ','), '', `${who} opened ${door} at ${when}.`, '',
      'You get this because you are their host in AccessX. Reception can check them out when they leave.', '', '—', `${tenantName || 'AccessX'} · sent by AccessX`].join('\n'),
  };
}

/** Unlock records that can be a visitor's arrival: a successful passcode unlock. */
const PASSCODE_UNLOCK = 4;
function arrivalCandidates(records) {
  return (Array.isArray(records) ? records : []).slice(0, 200).map(r => ({
    lockId: Number(r && r.lockId), recordType: Number(r && r.recordType), success: Number(r && r.success),
    code: String((r && r.keyboardPwd) || '').trim(), at: Number(r && (r.lockDate || r.serverDate)),
  })).filter(r => r.recordType === PASSCODE_UNLOCK && r.success === 1 && /^\d{4,12}$/.test(r.code) && Number.isFinite(r.lockId) && Number.isFinite(r.at));
}

module.exports = { LIMITS, settingsOf, validateSettings, planVisit, stateOf, rowToVisit, invitationEmail, invitationSms, arrivalEmail, arrivalCandidates };
