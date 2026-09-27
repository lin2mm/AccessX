/**
 * Reconciler — desired state vs. what is actually on the locks.
 * ====================================================================
 * Policy says who SHOULD have access; the credential registry says what
 * we HANDED OUT. When they disagree (user suspended, deleted, moved out
 * of a group, rule removed, credential expired) the credential must come
 * off the lock. Doing that by hand is where real systems leak access.
 *
 *   plan()    — pure: decide what to do (safe to show as a dry run)
 *   execute() — carry it out through the vendor, record every step
 *
 * Locks without a gateway cannot be changed remotely. Their credentials
 * go to `pending_removal`: someone must visit the lock, and the system
 * keeps nagging until an operator confirms it on site.
 */
const creds = require('./credentials-core');
const policy = require('./policy-core');
const compiler = require('./compiler-core');

const ACTOR = 'system:reconciler';
const DAY = 864e5;

const isExpiryOnly = reasons => reasons.every(r => r.startsWith('expired'));

function plan(snapshot, locks, { now = Date.now(), userId = null, lockFilter = () => true, dstHorizonDays = 14, slaHours = REMOVAL_SLA_HOURS } = {}) {
  const lockById = new Map((locks || []).map(l => [Number(l.lockId), l]));
  const online = lockId => Boolean((lockById.get(Number(lockId)) || {}).hasGateway);
  const actions = [];

  for (const flag of creds.reviewCredentials(snapshot, now)) {
    if (userId && flag.userId !== userId) continue;
    if (!lockFilter(flag.lockId)) continue;
    const base = { credentialId: flag.id, userId: flag.userId, lockId: Number(flag.lockId), reasons: flag.reasons };
    if (isExpiryOnly(flag.reasons)) {
      // The lock already refuses an expired code; removing it just frees a slot.
      actions.push({ ...base, type: 'expire', remote: online(flag.lockId) });
    } else if (online(flag.lockId)) {
      actions.push({ ...base, type: 'revoke', remote: true });
    } else {
      actions.push({ ...base, type: 'pending_removal', remote: false });
    }
  }

  // A lock that gained a gateway since: finish the removal remotely.
  for (const cred of snapshot.credentials || []) {
    if (cred.status !== 'pending_removal' || !online(cred.lockId) || !lockFilter(cred.lockId)) continue;
    if (userId && cred.userId !== userId) continue;
    actions.push({
      credentialId: cred.id, userId: cred.userId, lockId: Number(cred.lockId),
      reasons: [cred.revokeReason || 'pending removal'], type: 'revoke', remote: true,
    });
  }

  return {
    at: new Date(now).toISOString(), actions,
    notices: [...dstNotices(snapshot, locks, { now, days: dstHorizonDays, lockFilter }), ...overdueRemovals(snapshot, { now, lockFilter, slaHours })],
  };
}

/** First day in the horizon where the site's UTC offset differs from today. */
function nextOffsetChange(timeZone, now, days) {
  const offset = t => policy.offsetMs(new Date(t), timeZone);
  const today = offset(now);
  if (today === null) return null;
  for (let d = 1; d <= days; d++) {
    const t = now + d * DAY;
    if (offset(t) !== today) return { date: policy.localParts(new Date(t), timeZone).isoDate, shiftMinutes: (offset(t) - today) / 6e4 };
  }
  return null;
}

/**
 * Locks that store weekly windows in lock-local time follow DST
 * themselves; locks synced in UTC (or with no clock sync) drift by an
 * hour. Warn before it happens, not after the cleaner is locked out.
 */
/**
 * A code that could not be removed remotely (no gateway) still opens the
 * door until someone visits the lock. After REMOVAL_SLA_HOURS it is overdue:
 * a notice every run, and one `credential.removal_overdue` audit entry.
 */
const REMOVAL_SLA_HOURS = 48;
function overdueRemovals(snapshot, { now, lockFilter = () => true, slaHours = REMOVAL_SLA_HOURS }) {
  return (snapshot.credentials || [])
    .filter(c => c.status === 'pending_removal' && c.revokedAt && lockFilter(c.lockId))
    .map(c => ({ c, hours: Math.floor((now - Date.parse(c.revokedAt)) / 36e5) }))
    .filter(x => x.hours >= slaHours)
    .map(({ c, hours }) => ({
      type: 'removal_overdue', credentialId: c.id, lockId: c.lockId, userId: c.userId, since: c.revokedAt, ageHours: hours, slaHours,
      advice: 'This code still opens the door. Visit the lock, delete the code on the keypad or in the TTLock app, then confirm the removal here.',
    }));
}

function dstNotices(snapshot, locks, { now, days, lockFilter }) {
  const notices = [];
  for (const site of snapshot.sites || []) {
    const tz = policy.siteTimeZone(snapshot, site.id);
    if (!compiler.observesDst(tz)) continue;
    const change = nextOffsetChange(tz, now, days);
    if (!change) continue;
    const siteLocks = (snapshot.doorGroups || []).filter(d => d.siteId === site.id)
      .flatMap(d => d.lockIds || []).filter(id => lockFilter(id));
    if (!siteLocks.length) continue;
    const offline = siteLocks.filter(id => !((locks || []).find(l => Number(l.lockId) === Number(id)) || {}).hasGateway);
    notices.push({
      type: 'dst', siteId: site.id, site: site.name, timeZone: tz, date: change.date, shiftMinutes: change.shiftMinutes,
      locks: [...new Set(siteLocks)].length, offlineLocks: [...new Set(offline)],
      advice: offline.length
        ? 'Locks without a gateway cannot receive a clock correction — visit or verify them after the change.'
        : 'Gateway locks will be re-synced; verify one door the morning after the change.',
    });
  }
  return notices;
}

/**
 * Execute a plan. Vendor calls happen first; DB changes and audit entries
 * are queued on `uow` for one atomic commit. A vendor failure leaves the
 * credential active, records `credential.revoke_failed`, and the next run
 * retries — the loop converges instead of silently giving up.
 */
async function execute(planned, { vendor, uow, snapshot, actor = ACTOR, now = Date.now() }) {
  const results = [];
  const at = new Date(now).toISOString();
  for (const action of planned.actions) {
    const cred = (snapshot.credentials || []).find(c => c.id === action.credentialId);
    if (!cred) continue;
    const why = action.reasons.join('; ');
    try {
      let note = '';
      let type = action.type;
      if (action.remote && cred.type === 'passcode' && cred.vendorRef) {
        try {
          const out = await vendor.deletePasscode(cred.lockId, cred.vendorRef);
          if (out && out.alreadyGone) note = ' (already gone from the lock)';
        } catch (error) {
          // Lock turned out to be unreachable (gateway unbound/offline):
          // same as an offline lock — someone has to remove it on site.
          if (!(error && error.code === 'NO_GATEWAY') || action.type === 'pending_removal') throw error;
          if (cred.status === 'pending_removal') { results.push({ ...action, ok: true, status: 'pending_removal', unchanged: true }); continue; }
          type = 'pending_removal';
          note = `; ${error.message}, on-site removal required`;
        }
      }
      const status = type === 'expire' ? 'expired' : type === 'revoke' ? 'revoked' : 'pending_removal';
      uow.update('credentials', cred.id, { status, revokedAt: at, revokedBy: actor, revokeReason: why.slice(0, 200) });
      const verb = status === 'pending_removal' ? 'credential.pending_removal' : status === 'expired' ? 'credential.expire' : 'credential.auto_revoke';
      uow.audit(verb, `${cred.id} lock ${cred.lockId} user ${cred.userId}: ${why}${note}`, actor);
      results.push({ ...action, ok: true, status });
    } catch (error) {
      uow.audit('credential.revoke_failed', `${cred.id} lock ${cred.lockId}: ${String(error.message || error).slice(0, 160)}`, actor);
      results.push({ ...action, ok: false, error: String(error.message || error) });
    }
  }
  return {
    results,
    summary: {
      revoked: results.filter(r => r.ok && r.status === 'revoked').length,
      expired: results.filter(r => r.ok && r.status === 'expired').length,
      pendingRemoval: results.filter(r => r.ok && r.status === 'pending_removal' && !r.unchanged).length,
      failed: results.filter(r => !r.ok).length,
    },
  };
}

module.exports = { plan, execute, dstNotices, overdueRemovals, nextOffsetChange, ACTOR, REMOVAL_SLA_HOURS };
