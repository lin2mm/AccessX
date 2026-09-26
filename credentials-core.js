/**
 * Credential issuance + registry — shared by server.js and worker.js.
 * ====================================================================
 * Every code/card/key handed to a lock is registered here, so the system
 * always knows what *should* exist on each lock. That registry is what
 * later lets us detect drift ("this code should have been revoked").
 *
 * Honesty rule: a period passcode only knows start/end instants. It can
 * NOT enforce "Mon-Fri 08:00-18:30". When the granting rule has a daily
 * schedule, issuance is refused unless the operator explicitly
 * acknowledges the gap — the system never pretends to enforce what the
 * lock cannot.
 */
const policy = require('./policy-core');

const DAY = 864e5;
const LIMITS = { defaultDays: 7, maxDays: 90 };

const ENFORCEMENT = {
  LOCK: 'lock',       // fully enforced by the lock itself, even offline
  PARTIAL: 'partial', // lock enforces validity period; daily schedule is NOT enforced
};

function isAlwaysOpen(schedule) {
  if (!schedule) return true;
  if (schedule.denyOnHolidays) return false;
  const covered = new Set();
  for (const w of schedule.windows || []) {
    const from = String(w.from);
    const to = String(w.to);
    if (from === '00:00' && (to === '23:59' || to === '24:00')) (w.days || []).forEach(d => covered.add(d));
  }
  return [1, 2, 3, 4, 5, 6, 7].every(d => covered.has(d));
}

/** Rules that grant `userId` the lock at *some* time (ignores time of day). */
function grantingRules(db, user, lockId) {
  const rules = [];
  for (const groupId of user.groupIds || []) {
    for (const a of (db.assignments || []).filter(x => x.userGroupId === groupId)) {
      const doorGroup = (db.doorGroups || []).find(d => d.id === a.doorGroupId);
      if (!doorGroup || !(doorGroup.lockIds || []).map(Number).includes(Number(lockId))) continue;
      const schedule = (db.schedules || []).find(s => s.id === a.scheduleId) || null;
      const group = (db.userGroups || []).find(g => g.id === groupId);
      rules.push({ assignment: a, doorGroup, schedule, groupName: group ? group.name : groupId });
    }
  }
  return rules;
}

const toMs = value => {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
};

/**
 * Decide whether a passcode may be issued and with which validity.
 * Returns { ok, status, error?, credential?, warnings[] }.
 */
function planPasscode(db, { userId, lockId, startAt, endAt, acknowledgeScheduleGap = false, now = Date.now() }) {
  const warnings = [];
  if (!userId) return { ok: false, status: 400, error: 'userId is required: every credential belongs to a person' };
  if (!Number.isFinite(Number(lockId))) return { ok: false, status: 400, error: 'lockId is required' };

  const user = (db.users || []).find(u => u.id === userId);
  if (!user) return { ok: false, status: 404, error: 'unknown user' };
  if (user.suspended) return { ok: false, status: 403, error: 'user suspended' };

  const rules = grantingRules(db, user, lockId);
  if (!rules.length) return { ok: false, status: 403, error: 'no access rule grants this user this door' };

  let start = toMs(startAt);
  let end = toMs(endAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return { ok: false, status: 400, error: 'invalid startAt/endAt' };
  start = start === null ? now : start;
  end = end === null ? start + LIMITS.defaultDays * DAY : end;

  const userFrom = toMs(user.validFrom);
  const userTo = toMs(user.validTo);
  if (userFrom && start < userFrom) { start = userFrom; warnings.push('start moved to user validFrom'); }
  if (userTo && end > userTo) { end = userTo; warnings.push(`end clamped to user validTo (${new Date(userTo).toISOString()})`); }
  if (end - start > LIMITS.maxDays * DAY) {
    end = start + LIMITS.maxDays * DAY;
    warnings.push(`end clamped to the ${LIMITS.maxDays}-day maximum`);
  }
  if (end <= now) return { ok: false, status: 403, error: 'credential would already be expired' };
  if (end <= start) return { ok: false, status: 400, error: 'endAt must be after startAt' };

  const fullyEnforceable = rules.some(r => isAlwaysOpen(r.schedule));
  const enforcement = fullyEnforceable ? ENFORCEMENT.LOCK : ENFORCEMENT.PARTIAL;
  if (!fullyEnforceable) {
    const names = [...new Set(rules.map(r => r.schedule ? r.schedule.name : '24/7'))].join(', ');
    const gap = `A period passcode works at ANY time between start and end. The lock cannot enforce the schedule "${names}".`;
    if (!acknowledgeScheduleGap) {
      return {
        ok: false, status: 409, error: 'schedule cannot be enforced by a passcode',
        detail: gap, needs: 'acknowledgeScheduleGap', enforcement,
      };
    }
    warnings.push(gap);
  }

  const site = policy.siteForLock(db, lockId);
  return {
    ok: true,
    warnings,
    credential: {
      type: 'passcode',
      userId,
      lockId: Number(lockId),
      siteId: site ? site.id : null,
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      enforcement,
      rules: rules.map(r => `${r.groupName} → ${r.doorGroup.name} (${r.schedule ? r.schedule.name : '24/7'})`),
      status: 'active',
    },
  };
}

function register(db, credential, { issuedBy, vendorRef = null, code = '' }) {
  if (!Array.isArray(db.credentials)) db.credentials = [];
  const entry = {
    id: policy.uid('cred'),
    ...credential,
    vendorRef,
    codeHint: code ? `••••${String(code).slice(-2)}` : null, // never store the full code
    issuedBy,
    issuedAt: new Date().toISOString(),
  };
  db.credentials.push(entry);
  return entry;
}

/**
 * Compare every active credential against current policy. Anything the
 * policy would no longer issue is flagged for revocation.
 */
function reviewCredentials(db, now = Date.now()) {
  const flagged = [];
  for (const cred of db.credentials || []) {
    if (cred.status !== 'active') continue;
    const reasons = [];
    const user = (db.users || []).find(u => u.id === cred.userId);
    if (!user) reasons.push('user deleted');
    else {
      if (user.suspended) reasons.push('user suspended');
      const userTo = toMs(user.validTo);
      if (userTo && toMs(cred.endAt) > userTo) reasons.push('outlives the user\'s validTo');
      if (!grantingRules(db, user, cred.lockId).length) reasons.push('no rule grants this door any more');
    }
    if (toMs(cred.endAt) <= now) reasons.push('expired (remove from lock to free a slot)');
    if (reasons.length) flagged.push({ id: cred.id, userId: cred.userId, lockId: cred.lockId, reasons });
  }
  return flagged;
}

function revoke(db, id, { revokedBy, reason = 'manual' }) {
  const cred = (db.credentials || []).find(c => c.id === id);
  if (!cred) return null;
  cred.status = 'revoked';
  cred.revokedAt = new Date().toISOString();
  cred.revokedBy = revokedBy;
  cred.revokeReason = reason;
  return cred;
}

module.exports = { LIMITS, ENFORCEMENT, isAlwaysOpen, grantingRules, planPasscode, register, reviewCredentials, revoke };
