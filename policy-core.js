const auditCore = require('./audit-core');
const BLANK = {
  sites: [], doorGroups: [], userGroups: [], users: [], schedules: [],
  holidays: [], assignments: [], roles: [], credentials: [],
};

const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

function minutes(hhmm) {
  const [hour, minute] = String(hhmm).split(':').map(Number);
  return hour * 60 + (minute || 0);
}

/* ------------------------------------------------------------------ */
/* Time zones                                                           */
/* Every schedule is evaluated in the *site's* local time. Instants     */
/* (validFrom/validTo, credential expiry) stay absolute.                */
/* ------------------------------------------------------------------ */
const DEFAULT_TZ = 'UTC';
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map();

function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }));
  }
  return formatters.get(timeZone);
}

/** Wall-clock parts of `date` in `timeZone`. */
function localParts(date, timeZone = DEFAULT_TZ) {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TZ;
  const parts = {};
  for (const part of formatter(tz).formatToParts(date)) parts[part.type] = part.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const pad = n => String(n).padStart(2, '0');
  return {
    timeZone: tz, year, month, day, hour, minute,
    isoDay: WEEKDAY[parts.weekday],
    isoDate: `${year}-${pad(month)}-${pad(day)}`,
    minutes: hour * 60 + minute,
    label: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)} ${tz}`,
  };
}

function offsetMs(instant, timeZone) {
  const p = localParts(new Date(instant), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(instant / 60000) * 60000;
}

/**
 * Convert a site-local wall-clock time ("2026-09-28T21:00") to an instant.
 * Non-existent times (DST spring-forward gap) resolve to the later offset.
 */
function zonedTimeToDate(localIso, timeZone = DEFAULT_TZ) {
  const match = String(localIso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return new Date(NaN);
  const [, y, mo, d, h, mi] = match.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let instant = guess - offsetMs(guess, timeZone);
  const corrected = guess - offsetMs(instant, timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

function siteTimeZone(db, siteId) {
  const site = (db.sites || []).find(item => item.id === siteId);
  if (site && isValidTimeZone(site.timezone)) return site.timezone;
  const fallback = db.settings && db.settings.defaultTimezone;
  return isValidTimeZone(fallback) ? fallback : DEFAULT_TZ;
}

/** Site that owns a lock (first door group wins). */
function siteForLock(db, lockId) {
  const doorGroup = (db.doorGroups || []).find(item => (item.lockIds || []).map(Number).includes(Number(lockId)));
  if (!doorGroup) return null;
  return (db.sites || []).find(item => item.id === doorGroup.siteId) || null;
}

function isHoliday(db, isoDate, siteId) {
  return (db.holidays || []).some(h => h.date === isoDate && (!h.siteId || h.siteId === siteId));
}

const previousIsoDay = isoDay => (isoDay === 1 ? 7 : isoDay - 1);

function scheduleAllows(db, schedule, date, siteId) {
  const timeZone = siteTimeZone(db, siteId);
  const local = localParts(date, timeZone);
  const tzNote = `(${local.label})`;
  if (!schedule) return { allowed: true, reason: 'no schedule (24/7)', localTime: local.label };
  if (schedule.validFrom && date < new Date(schedule.validFrom)) {
    return { allowed: false, reason: `schedule not yet valid (from ${schedule.validFrom})`, localTime: local.label };
  }
  if (schedule.validTo && date > new Date(schedule.validTo)) {
    return { allowed: false, reason: `schedule expired (${schedule.validTo})`, localTime: local.label };
  }
  if (schedule.denyOnHolidays && isHoliday(db, local.isoDate, siteId)) {
    return { allowed: false, reason: `holiday — access denied by schedule ${tzNote}`, localTime: local.label };
  }

  const nowMin = local.minutes;
  for (const window of schedule.windows || []) {
    const days = window.days || [];
    const start = minutes(window.from);
    const end = minutes(window.to);
    if (start <= end) {
      if (days.includes(local.isoDay) && nowMin >= start && nowMin <= end) {
        return { allowed: true, reason: `within ${window.from}-${window.to} ${tzNote}`, localTime: local.label };
      }
      continue;
    }
    // Overnight window (e.g. Fri 22:00-06:00): the part after midnight
    // belongs to the day the window *started* on.
    if (nowMin >= start && days.includes(local.isoDay)) {
      return { allowed: true, reason: `within overnight ${window.from}-${window.to} ${tzNote}`, localTime: local.label };
    }
    if (nowMin <= end && days.includes(previousIsoDay(local.isoDay))) {
      return { allowed: true, reason: `within overnight ${window.from}-${window.to} (started previous day) ${tzNote}`, localTime: local.label };
    }
  }
  return { allowed: false, reason: `outside permitted hours ${tzNote}`, localTime: local.label };
}

function evaluate(db, userId, lockId, when = new Date()) {
  const user = db.users.find(item => item.id === userId);
  if (!user) return { allowed: false, reason: 'unknown user' };
  if (user.suspended) return { allowed: false, reason: 'user suspended' };
  if (user.validTo && when > new Date(user.validTo)) {
    return { allowed: false, reason: `credential expired ${user.validTo}` };
  }
  if (user.validFrom && when < new Date(user.validFrom)) {
    return { allowed: false, reason: `credential not active until ${user.validFrom}` };
  }

  const groups = db.userGroups.filter(group => (user.groupIds || []).includes(group.id));
  const matched = [];
  for (const group of groups) {
    for (const assignment of db.assignments.filter(item => item.userGroupId === group.id)) {
      const doorGroup = db.doorGroups.find(item => item.id === assignment.doorGroupId);
      if (!doorGroup || !(doorGroup.lockIds || []).includes(Number(lockId))) continue;
      const schedule = db.schedules.find(item => item.id === assignment.scheduleId);
      const site = db.sites.find(item => item.id === doorGroup.siteId);
      const result = scheduleAllows(db, schedule, when, site && site.id);
      matched.push({
        group: group.name,
        doorGroup: doorGroup.name,
        schedule: schedule ? schedule.name : '24/7',
        ...result,
      });
      if (result.allowed) {
        return {
          allowed: true,
          reason: `via group "${group.name}" -> door group "${doorGroup.name}" (${schedule ? schedule.name : '24/7'}): ${result.reason}`,
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

function doorsForUser(db, userId, when = new Date()) {
  const result = [];
  for (const doorGroup of db.doorGroups) {
    for (const lockId of doorGroup.lockIds || []) {
      const decision = evaluate(db, userId, lockId, when);
      if (decision.allowed) {
        result.push({ lockId, doorGroup: doorGroup.name, siteId: doorGroup.siteId, reason: decision.reason });
      }
    }
  }
  return result;
}

/**
 * Queue an audit entry. Adapters (acl.save / worker saveAcl) seal the
 * queue into the append-only hash chain BEFORE persisting state.
 */
function audit(db, action, detail, actor = 'system') {
  if (!Array.isArray(db.auditPending)) {
    Object.defineProperty(db, 'auditPending', { value: [], enumerable: false, writable: true, configurable: true });
  }
  const entry = auditCore.pending(action, detail, actor);
  db.auditPending.push(entry);
  return entry;
}

module.exports = {
  BLANK, uid, scheduleAllows, evaluate, doorsForUser, audit,
  DEFAULT_TZ, isValidTimeZone, localParts, offsetMs, zonedTimeToDate, siteTimeZone, siteForLock,
};
