/**
 * Access review (R18): who can open which doors, and who administers what,
 * frozen at the start of a review so each line can be kept or removed.
 * Pure functions; the API (api-core.js) stores items and acts on decisions.
 *
 * ISO/IEC 27001:2022 A.5.18 asks that access rights are reviewed at planned
 * intervals; SOC 2 CC6.2/CC6.3 ask the same for registration, change and
 * removal. This supports evidence for those; it is not a compliance claim.
 */
const { grantingRules } = require('./credentials-core');

const DEFAULTS = { everyDays: 0, dueDays: 14 };
const LIMITS = { everyDays: [0, 30, 90, 180, 365], dueDays: [3, 60], maxItems: 5000, removePerRequest: 100, remindDaysBefore: 3 };

function settingsOf(tenantSettings) {
  const s = (tenantSettings && tenantSettings.accessReview) || {};
  return {
    everyDays: LIMITS.everyDays.includes(Number(s.everyDays)) ? Number(s.everyDays) : DEFAULTS.everyDays,
    dueDays: Number.isInteger(s.dueDays) && s.dueDays >= LIMITS.dueDays[0] && s.dueDays <= LIMITS.dueDays[1] ? s.dueDays : DEFAULTS.dueDays,
  };
}

function validateSettings(body) {
  const out = {};
  if (body.everyDays !== undefined) {
    if (!LIMITS.everyDays.includes(Number(body.everyDays))) return { ok: false, error: `everyDays must be one of ${LIMITS.everyDays.join(', ')} (0 = only when started by hand)` };
    out.everyDays = Number(body.everyDays);
  }
  if (body.dueDays !== undefined) {
    const d = Number(body.dueDays);
    if (!Number.isInteger(d) || d < LIMITS.dueDays[0] || d > LIMITS.dueDays[1]) return { ok: false, error: `dueDays must be ${LIMITS.dueDays[0]}–${LIMITS.dueDays[1]}` };
    out.dueDays = d;
  }
  return { ok: true, value: out };
}

/** Doors of a site: every lock in one of its door groups. */
function siteLocks(snap, siteId) {
  return new Set((snap.doorGroups || []).filter(g => g.siteId === siteId).flatMap(g => (g.lockIds || []).map(Number)));
}

/** A person's own (non-visitor) active codes on a site's doors. */
function activeCodes(snap, userId, siteId, locks = siteLocks(snap, siteId)) {
  return (snap.credentials || []).filter(c => c.status === 'active' && !c.visitId && c.userId === userId && (c.siteId === siteId || locks.has(Number(c.lockId))));
}

/** Which doors of the site the person's groups grant (any schedule), and through which user groups. */
function grants(snap, user, locks) {
  const lockIds = new Set(); const groupIds = new Set();
  for (const lockId of locks) {
    for (const r of grantingRules(snap, user, lockId)) { lockIds.add(lockId); groupIds.add(r.assignment.userGroupId); }
  }
  return { lockIds: [...lockIds].sort((a, b) => a - b), groupIds: [...groupIds].sort() };
}

/**
 * The lines of a new review.
 *   door:  one per (site, person) with a door granted there or an active code there
 *   admin: one per operator stored in the database (env operators cannot be removed here)
 * Suspended people and people past their end date have no access, so no line.
 */
function buildItems(snap, operators, { now = Date.now() } = {}) {
  const items = [];
  for (const site of snap.sites || []) {
    const locks = siteLocks(snap, site.id);
    for (const user of snap.users || []) {
      if (user.suspended) continue;
      if (user.validTo && Date.parse(user.validTo) < now) continue;
      const g = grants(snap, user, locks);
      const codes = activeCodes(snap, user.id, site.id, locks);
      if (!g.lockIds.length && !codes.length) continue;
      items.push({ kind: 'door', siteId: site.id, subjectId: user.id, detail: { lockIds: g.lockIds, groupIds: g.groupIds, codes: codes.length, source: user.source || null } });
    }
  }
  for (const o of operators || []) {
    if (o.revokedAt) continue;
    items.push({ kind: 'admin', siteId: null, subjectId: o.id, detail: { role: o.role, siteIds: o.siteIds || [], breakGlass: Boolean(o.breakGlass), lastLoginAt: o.lastLoginAt || null, auth: o.ssoLinked ? 'sso' : o.email ? 'sso (invited)' : 'token' } });
  }
  return items;
}

/**
 * What removing a person's access at one site changes, before it is done:
 * the site's user groups they leave, the codes to revoke, and what would
 * still grant a door there (a group of another site, or of none).
 */
function planRemoval(snap, userId, siteId) {
  const user = (snap.users || []).find(u => u.id === userId);
  if (!user) return { ok: false, outcome: 'the person no longer exists: nothing to remove' };
  const locks = siteLocks(snap, siteId);
  const siteGroupIds = new Set((snap.userGroups || []).filter(g => g.siteId === siteId).map(g => g.id));
  const leave = (user.groupIds || []).filter(id => siteGroupIds.has(id));
  const keepGroups = (user.groupIds || []).filter(id => !siteGroupIds.has(id));
  const after = { ...user, groupIds: keepGroups };
  const still = grants(snap, after, locks);
  const groupName = id => ((snap.userGroups || []).find(g => g.id === id) || {}).name || id;
  const directory = (snap.directoryGroups || []).filter(g => g.userGroupId && leave.includes(g.userGroupId) && (g.memberIds || []).includes(userId)).map(g => g.displayName);
  return {
    ok: true, user, leave, keepGroups, codes: activeCodes(snap, userId, siteId, locks),
    stillLockIds: still.lockIds, stillGroups: still.groupIds.map(groupName), directory,
  };
}

/** Counts for a review (or its items so far). */
function summarise(items) {
  const s = { total: items.length, kept: 0, removed: 0, undecided: 0, door: 0, admin: 0 };
  for (const i of items) {
    s[i.kind] += 1;
    if (i.decision === 'keep') s.kept += 1;
    else if (i.decision === 'remove') s.removed += 1;
    else s.undecided += 1;
  }
  return s;
}

module.exports = { DEFAULTS, LIMITS, settingsOf, validateSettings, siteLocks, activeCodes, buildItems, planRemoval, summarise };
