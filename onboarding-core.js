'use strict';
/**
 * Office setup pack: from a freshly connected TTLock fleet to working rules in
 * one reviewed step. Pure: plan(locks, snapshot, options) proposes sites,
 * door groups, schedules, people groups and assignments; api-core applies the
 * plan through the normal validation, audit and four-eyes gates.
 *
 * - Sites: one per TTLock group (`groupName` on /v3/lock/list); an existing
 *   site with the same name is reused. Locks without a group go to one site.
 * - Door groups per site, by the door's name: Entrances, Offices, Facilities,
 *   and Secure rooms (server/comms/IT/electrical/safe/records/lab/pharmacy…),
 *   which is created **sensitive** and gets no assignment: access there needs
 *   a named group and a second approver. Doors already in a door group are
 *   left alone (re-running the pack is safe).
 * - Schedules: Office hours (Mon–Fri 07:00–19:00) and Cleaning (Mon–Fri
 *   18:00–22:00), both closed on holidays; reused by name if present.
 * - People groups per site: Staff (entrances + offices in office hours) and
 *   Cleaners (entrances, offices, facilities in cleaning hours). Groups start
 *   empty: people arrive by SCIM/SSO or by hand, and codes are issued then.
 */

const KINDS = [
  // Checked in this order: "Server room entrance" is secure, "Storage gate" an entrance.
  ['secure', /server|\bcomms?\b|data ?(cent(re|er)|room)|network|\brack\b|\bit\b|electrical|riser|\bsafe\b|\bcash\b|records|\bhr\b|finance|payroll|\blab\b|pharmacy|drugs?\b|\bmeds?\b|medicine|cctv|security|armou?ry/i],
  ['entrance', /entrance|entry|\bfront\b|main door|lobby|reception|foyer|street|\bgate\b|external|turnstile/i],
  ['facilities', /clean|janitor|cupboard|store ?room|storage|\bstores?\b|\bbins?\b|refuse|\bplant\b|boiler|loading|\bdock\b|warehouse|back door|maintenance|utility/i],
];
const LABEL = { entrance: 'Entrances', office: 'Offices', facilities: 'Facilities', secure: 'Secure rooms' };
const DEFAULTS = {
  officeHours: { days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' },
  cleaningHours: { days: [1, 2, 3, 4, 5], from: '18:00', to: '22:00' },
};
const FALLBACK_SITE = 'Main office';

function classify(alias) {
  const name = String(alias || '');
  for (const [kind, re] of KINDS) if (re.test(name)) return kind;
  return 'office';
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * @param locks  vendor.listLocks() — { lockId, lockAlias, groupName }
 * @param snap   tenant snapshot (sites, doorGroups, schedules, userGroups, assignments)
 * @param opts   { timeZone, officeHours?, cleaningHours? }
 */
function plan(locks, snap, opts = {}) {
  const timeZone = opts.timeZone;
  const grouped = new Set(snap.doorGroups.flatMap(g => g.lockIds.map(Number)));
  const bySite = new Map();
  const alreadyGrouped = [];
  for (const l of locks) {
    if (grouped.has(Number(l.lockId))) { alreadyGrouped.push(Number(l.lockId)); continue; }
    const site = String(l.groupName || '').trim() || FALLBACK_SITE;
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(l);
  }
  const multi = bySite.size > 1;
  const out = { timeZone, sites: [], doorGroups: [], schedules: [], userGroups: [], assignments: [], alreadyGrouped, notes: [] };

  const schedule = (key, name, window, denyOnHolidays) => {
    const existing = snap.schedules.find(s => same(s.name, name));
    out.schedules.push({ key, name, windows: [window], denyOnHolidays, existingId: existing ? existing.id : null });
  };
  schedule('office', 'Office hours', opts.officeHours || DEFAULTS.officeHours, true);
  schedule('cleaning', 'Cleaning', opts.cleaningHours || DEFAULTS.cleaningHours, true);

  for (const [siteName, siteLocks] of bySite) {
    const existing = snap.sites.find(s => same(s.name, siteName));
    const siteKey = `site:${siteName}`;
    out.sites.push({ key: siteKey, name: siteName, timezone: existing ? existing.timezone : timeZone, existingId: existing ? existing.id : null, doors: siteLocks.length });
    const suffix = multi ? ` (${siteName})` : '';
    const kinds = new Map();
    for (const l of siteLocks) {
      const k = classify(l.lockAlias);
      if (!kinds.has(k)) kinds.set(k, []);
      kinds.get(k).push({ lockId: Number(l.lockId), name: l.lockAlias || String(l.lockId) });
    }
    for (const kind of ['entrance', 'office', 'facilities', 'secure']) {
      if (!kinds.has(kind)) continue;
      const doors = kinds.get(kind);
      out.doorGroups.push({ key: `${siteKey}:${kind}`, siteKey, kind, name: `${LABEL[kind]}${suffix}`, lockIds: doors.map(d => d.lockId), doors: doors.map(d => d.name), sensitive: kind === 'secure' });
    }
    const people = [['staff', `Staff${suffix}`], ['cleaners', `Cleaners${suffix}`]];
    for (const [who, name] of people) {
      const existingUg = snap.userGroups.find(g => same(g.name, name));
      out.userGroups.push({ key: `${siteKey}:${who}`, siteKey, name, existingId: existingUg ? existingUg.id : null });
    }
    const grant = (who, kind, scheduleKey) => {
      if (kinds.has(kind)) out.assignments.push({ userGroupKey: `${siteKey}:${who}`, doorGroupKey: `${siteKey}:${kind}`, scheduleKey });
    };
    grant('staff', 'entrance', 'office');
    grant('staff', 'office', 'office');
    grant('cleaners', 'entrance', 'cleaning');
    grant('cleaners', 'office', 'cleaning');
    grant('cleaners', 'facilities', 'cleaning');
    if (kinds.has('secure')) {
      out.notes.push(`${siteName}: ${kinds.get('secure').map(d => d.name).join(', ')} → "Secure rooms", marked sensitive with no access yet. Create a small named group (e.g. "IT") and assign it; that change needs a second approver.`);
    }
    if (!kinds.has('entrance')) out.notes.push(`${siteName}: no door looks like an entrance; staff get the office doors only. Rename the doors in TTLock or move them after setup.`);
  }
  if (!locks.length) out.notes.push('No locks in the connected TTLock account yet.');
  if (alreadyGrouped.length) out.notes.push(`${alreadyGrouped.length} door(s) already belong to a door group and were left as they are.`);
  return out;
}

module.exports = { plan, classify, DEFAULTS, KINDS: KINDS.map(([k]) => k), LABEL };
