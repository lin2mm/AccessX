/**
 * Policy compiler — "what will the lock ACTUALLY enforce?"
 * ====================================================================
 * Rules live in the cloud (group → door group → schedule). Doors live in
 * the field, often offline, on locks with limited memory and features.
 * This compiler lowers each rule to what each lock can store natively and
 * reports, honestly, the enforcement level you really get:
 *
 *   lock   — the lock enforces it by itself, even with no network
 *   synced — correct only if the cloud pushes changes in time
 *            (needs a gateway: holidays, suspensions, DST re-sync)
 *   cloud  — only AccessX remote unlocks are checked; a code or card
 *            issued for this rule would work outside the rule
 *
 * Lock capability inputs (per lock):
 *   { lockId, name, hasGateway, cyclic }   cyclic = can store weekly
 *   time windows on a credential (e.g. TTLock cyclic cards/fingerprints;
 *   model-dependent — unknown ⇒ false, conservative).
 */
const policy = require('./policy-core');
const { isAlwaysOpen } = require('./credentials-core');

const LEVELS = ['cloud', 'synced', 'lock']; // worst → best
const worst = (a, b) => (LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b);

const minutes = hhmm => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};
const nextDay = d => (d === 7 ? 1 : d + 1);

/**
 * Lower schedule windows to lock-native weekly slots
 * { weekDay 1..7, startMin, endMin } — overnight windows are split in two.
 */
function compileWindows(schedule) {
  const slots = [];
  for (const w of (schedule && schedule.windows) || []) {
    const start = minutes(w.from);
    const end = minutes(w.to);
    for (const day of w.days || []) {
      if (start <= end) slots.push({ weekDay: day, startMin: start, endMin: end });
      else {
        slots.push({ weekDay: day, startMin: start, endMin: 1439 });
        slots.push({ weekDay: nextDay(day), startMin: 0, endMin: end });
      }
    }
  }
  return slots.sort((a, b) => a.weekDay - b.weekDay || a.startMin - b.startMin);
}

/** Does the zone change its UTC offset during the year (DST)? */
function observesDst(timeZone, year = new Date().getUTCFullYear()) {
  const offsets = new Set();
  for (let month = 0; month < 12; month++) {
    const instant = Date.UTC(year, month, 15, 12);
    const p = policy.localParts(new Date(instant), timeZone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - instant);
  }
  return offsets.size > 1;
}

function upcomingHolidays(db, siteId, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  return (db.holidays || []).filter(h => h.date >= today && (!h.siteId || h.siteId === siteId));
}

/** Enforcement of one rule on one lock. */
function lowerRuleOnLock(db, { schedule, siteId }, lock, now) {
  const reasons = [];
  let level = 'lock';
  const timeZone = policy.siteTimeZone(db, siteId);

  if (!isAlwaysOpen(schedule)) {
    if ((schedule.windows || []).length) {
      if (lock.cyclic) {
        reasons.push({ level: 'lock', text: 'weekly windows stored on the credential (cyclic)' });
        if (observesDst(timeZone)) {
          level = worst(level, 'synced');
          reasons.push({
            level: 'synced',
            text: `${timeZone} observes daylight saving; lock clocks use a fixed UTC offset, so windows shift by 1h unless re-synced at each DST change`,
          });
        }
      } else {
        level = worst(level, 'cloud');
        reasons.push({
          level: 'cloud',
          text: 'lock cannot store weekly windows: only remote unlocks are time-checked; codes/cards would work around the clock',
        });
      }
    }
    if (schedule.denyOnHolidays) {
      const holidays = upcomingHolidays(db, siteId, now);
      if (lock.hasGateway) {
        level = worst(level, 'synced');
        reasons.push({ level: 'synced', text: `holidays (${holidays.length} upcoming) need the cloud to suspend credentials via the gateway` });
      } else {
        level = worst(level, 'cloud');
        reasons.push({ level: 'cloud', text: 'holiday closures cannot reach a lock without a gateway' });
      }
    }
  } else {
    reasons.push({ level: 'lock', text: '24/7 — a validity period on the credential is enough' });
  }
  if (schedule && (schedule.validFrom || schedule.validTo)) {
    reasons.push({ level: 'lock', text: 'schedule validity dates map to the credential period' });
  }
  return { level, reasons };
}

/**
 * Compile the whole policy against the fleet.
 * locks: [{ lockId, name, hasGateway, cyclic }]
 */
function compile(db, locks, { now = Date.now() } = {}) {
  const lockById = new Map(locks.map(l => [Number(l.lockId), l]));
  const rules = [];
  const perLock = new Map();

  for (const a of db.assignments || []) {
    const group = (db.userGroups || []).find(g => g.id === a.userGroupId);
    const doorGroup = (db.doorGroups || []).find(d => d.id === a.doorGroupId);
    const schedule = (db.schedules || []).find(s => s.id === a.scheduleId) || null;
    if (!group || !doorGroup) continue;
    const members = (db.users || []).filter(u => (u.groupIds || []).includes(group.id) && !u.suspended);

    const doors = [];
    let ruleLevel = 'lock';
    for (const lockId of doorGroup.lockIds || []) {
      const lock = lockById.get(Number(lockId)) || { lockId, name: `lock ${lockId}`, hasGateway: false, cyclic: false, unknown: true };
      const lowered = lowerRuleOnLock(db, { schedule, siteId: doorGroup.siteId }, lock, now);
      ruleLevel = worst(ruleLevel, lowered.level);
      doors.push({ lockId: Number(lockId), name: lock.name, ...lowered });

      if (!perLock.has(Number(lockId))) perLock.set(Number(lockId), { lock, rules: 0, level: 'lock', credentials: 0 });
      const entry = perLock.get(Number(lockId));
      entry.rules++;
      entry.credentials += members.length;
      entry.level = worst(entry.level, lowered.level);
    }

    rules.push({
      assignmentId: a.id,
      who: group.name,
      doorGroup: doorGroup.name,
      schedule: schedule ? schedule.name : '24/7',
      members: members.length,
      level: ruleLevel,
      slots: schedule && !isAlwaysOpen(schedule) ? compileWindows(schedule) : [],
      doors,
    });
  }

  const lockReports = [...perLock.values()].map(({ lock, rules: count, level, credentials }) => {
    const issues = [];
    if (!lock.hasGateway) issues.push('no gateway: revocations and suspensions need an on-site visit with the app');
    if (!lock.cyclic) issues.push('no weekly-window support: time-restricted rules are cloud-only here');
    if (lock.unknown) issues.push('lock not found in the vendor fleet');
    return {
      lockId: Number(lock.lockId), name: lock.name, hasGateway: Boolean(lock.hasGateway), cyclic: Boolean(lock.cyclic),
      rules: count, desiredCredentials: credentials, level, issues,
    };
  }).sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.lockId - b.lockId);

  const count = level => rules.filter(r => r.level === level).length;
  return {
    generatedAt: new Date(now).toISOString(),
    summary: {
      rules: rules.length,
      lock: count('lock'),
      synced: count('synced'),
      cloud: count('cloud'),
      fullyEnforcedPct: rules.length ? Math.round((count('lock') / rules.length) * 100) : 100,
    },
    rules: rules.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level)),
    locks: lockReports,
  };
}

module.exports = { LEVELS, compile, compileWindows, observesDst, lowerRuleOnLock };
