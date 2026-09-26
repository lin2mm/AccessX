const BLANK = {
  sites: [], doorGroups: [], userGroups: [], users: [], schedules: [],
  holidays: [], assignments: [], roles: [], auditLog: [],
};

const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

function minutes(hhmm) {
  const [hour, minute] = String(hhmm).split(':').map(Number);
  return hour * 60 + (minute || 0);
}

function isHoliday(db, date, siteId) {
  const iso = date.toISOString().slice(0, 10);
  return db.holidays.some(h => h.date === iso && (!h.siteId || h.siteId === siteId));
}

function scheduleAllows(db, schedule, date, siteId) {
  if (!schedule) return { allowed: true, reason: 'no schedule (24/7)' };
  if (schedule.validFrom && date < new Date(schedule.validFrom)) {
    return { allowed: false, reason: `schedule not yet valid (from ${schedule.validFrom})` };
  }
  if (schedule.validTo && date > new Date(schedule.validTo)) {
    return { allowed: false, reason: `schedule expired (${schedule.validTo})` };
  }
  if (isHoliday(db, date, siteId) && schedule.denyOnHolidays) {
    return { allowed: false, reason: 'holiday — access denied by schedule' };
  }

  const isoDay = ((date.getUTCDay() + 6) % 7) + 1;
  const nowMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  for (const window of schedule.windows || []) {
    if (!window.days.includes(isoDay)) continue;
    const start = minutes(window.from);
    const end = minutes(window.to);
    if (start <= end && nowMin >= start && nowMin <= end) {
      return { allowed: true, reason: `within ${window.from}-${window.to}` };
    }
    if (start > end && (nowMin >= start || nowMin <= end)) {
      return { allowed: true, reason: `within overnight ${window.from}-${window.to}` };
    }
  }
  return { allowed: false, reason: 'outside permitted hours' };
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

function audit(db, action, detail, actor = 'system') {
  db.auditLog.unshift({ id: uid('log'), ts: new Date().toISOString(), actor, action, detail });
  db.auditLog = db.auditLog.slice(0, 2000);
}

module.exports = { BLANK, uid, scheduleAllows, evaluate, doorsForUser, audit };
