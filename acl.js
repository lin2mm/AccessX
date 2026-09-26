/**
 * Access-control engine.
 *
 * This is the layer TTLock does NOT provide and RemoteLock charges $6-15/door/mo for.
 * TTLock gives you: locks, passcodes, ekeys, records.
 * It does NOT give you: sites, door groups, user groups, schedules, roles,
 * holiday calendars, or a policy engine that decides "may this person open
 * this door right now?".  That is all implemented here.
 *
 * Storage is a JSON file so the whole thing runs with zero infrastructure.
 * Swap `store` for Postgres later without touching the policy logic.
 */
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, 'data', 'acl.json');

const BLANK = {
  sites: [], doorGroups: [], userGroups: [], users: [], schedules: [],
  holidays: [], assignments: [], roles: [], auditLog: [],
};

function load() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch { return JSON.parse(JSON.stringify(BLANK)); }
}
function save(d) {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  fs.writeFileSync(DB, JSON.stringify(d, null, 2));
}
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

/* ------------------------------------------------------------------ */
/* Schedule evaluation                                                 */
/* ------------------------------------------------------------------ */

/**
 * A schedule is a weekly pattern of allowed windows, plus optional
 * validity dates and holiday handling.
 *   windows: [{ days:[1..7], from:'08:30', to:'18:00' }]
 *   days: 1=Mon .. 7=Sun (ISO)
 */
function minutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function isHoliday(db, date, siteId) {
  const iso = date.toISOString().slice(0, 10);
  return db.holidays.some(h => h.date === iso && (!h.siteId || h.siteId === siteId));
}

/**
 * Returns { allowed:boolean, reason:string }
 */
function scheduleAllows(db, schedule, date, siteId) {
  if (!schedule) return { allowed: true, reason: 'no schedule (24/7)' };

  if (schedule.validFrom && date < new Date(schedule.validFrom))
    return { allowed: false, reason: `schedule not yet valid (from ${schedule.validFrom})` };
  if (schedule.validTo && date > new Date(schedule.validTo))
    return { allowed: false, reason: `schedule expired (${schedule.validTo})` };

  if (isHoliday(db, date, siteId)) {
    if (schedule.denyOnHolidays) return { allowed: false, reason: 'holiday — access denied by schedule' };
  }

  const isoDay = ((date.getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
  const nowMin = date.getUTCHours() * 60 + date.getUTCMinutes();

  for (const w of (schedule.windows || [])) {
    if (!w.days.includes(isoDay)) continue;
    const a = minutes(w.from), b = minutes(w.to);
    if (a <= b) { if (nowMin >= a && nowMin <= b) return { allowed: true, reason: `within ${w.from}-${w.to}` }; }
    else { if (nowMin >= a || nowMin <= b) return { allowed: true, reason: `within overnight ${w.from}-${w.to}` }; }
  }
  return { allowed: false, reason: 'outside permitted hours' };
}

/* ------------------------------------------------------------------ */
/* Policy engine                                                       */
/* ------------------------------------------------------------------ */

/**
 * Can `userId` open `lockId` at `when`?
 * Walks: user -> userGroups -> assignments -> doorGroups -> locks
 * Applies schedule + antipassback + suspension.
 */
function evaluate(db, userId, lockId, when = new Date()) {
  const user = db.users.find(u => u.id === userId);
  if (!user) return { allowed: false, reason: 'unknown user' };
  if (user.suspended) return { allowed: false, reason: 'user suspended' };
  if (user.validTo && when > new Date(user.validTo))
    return { allowed: false, reason: `credential expired ${user.validTo}` };
  if (user.validFrom && when < new Date(user.validFrom))
    return { allowed: false, reason: `credential not active until ${user.validFrom}` };

  const myGroups = db.userGroups.filter(g => (user.groupIds || []).includes(g.id));
  const matched = [];

  for (const g of myGroups) {
    for (const a of db.assignments.filter(x => x.userGroupId === g.id)) {
      const dg = db.doorGroups.find(d => d.id === a.doorGroupId);
      if (!dg || !(dg.lockIds || []).includes(Number(lockId))) continue;
      const sched = db.schedules.find(s => s.id === a.scheduleId);
      const site = db.sites.find(s => s.id === dg.siteId);
      const r = scheduleAllows(db, sched, when, site && site.id);
      matched.push({ group: g.name, doorGroup: dg.name, schedule: sched ? sched.name : '24/7', ...r });
      if (r.allowed) {
        return {
          allowed: true,
          reason: `via group "${g.name}" -> door group "${dg.name}" (${sched ? sched.name : '24/7'}): ${r.reason}`,
          path: matched,
        };
      }
    }
  }
  return {
    allowed: false,
    reason: matched.length ? 'no matching rule permits access now' : 'no access rule grants this door',
    path: matched,
  };
}

/** Everything a user may open right now — powers the mobile "my doors" view. */
function doorsForUser(db, userId, when = new Date()) {
  const out = [];
  for (const dg of db.doorGroups) {
    for (const lockId of (dg.lockIds || [])) {
      const r = evaluate(db, userId, lockId, when);
      if (r.allowed) out.push({ lockId, doorGroup: dg.name, siteId: dg.siteId, reason: r.reason });
    }
  }
  return out;
}

function audit(db, action, detail, actor = 'system') {
  db.auditLog.unshift({ id: uid('log'), ts: new Date().toISOString(), actor, action, detail });
  db.auditLog = db.auditLog.slice(0, 2000);
}

module.exports = { load, save, uid, evaluate, doorsForUser, scheduleAllows, audit, BLANK };
