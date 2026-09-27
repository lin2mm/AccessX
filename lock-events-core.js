/**
 * Lock alarms from TTLock unlock records (callback or record list).
 * =================================================================
 * TTLock record types (hass-ttlock RecordType, TTLock lockRecord/list):
 *   29 ILLEGAL_UNLOCKING       the lock reports it was opened without a credential
 *   44 ANTI_THEFT_ALARM        tamper / anti-theft alarm
 *   48 SYSTEM_LOCKED           keypad locked after repeated wrong codes
 *   64 DOOR_NOT_CLOSED_ALARM   door left open (door sensor)
 *
 * Informational: nothing here changes access. The first three are security
 * events (`lock_alarm`, on by default, always instant); a door left open is
 * `door_left_open` (opt-in, may wait for the daily summary).
 */
const ALARM_TYPES = {
  29: { kind: 'forced', label: 'opened without a credential', event: 'lock_alarm' },
  44: { kind: 'tamper', label: 'tamper alarm', event: 'lock_alarm' },
  48: { kind: 'keypad_locked', label: 'keypad locked after repeated wrong codes', event: 'lock_alarm' },
  64: { kind: 'door_left_open', label: 'door left open', event: 'door_left_open' },
};
const KINDS = Object.fromEntries(Object.values(ALARM_TYPES).map(t => [t.kind, t]));
// One alert per lock and kind in this window; later ones are kept (table) but not re-announced.
const THROTTLE_MS = 30 * 60e3;
// A record uploaded later than this (phone sync of a lock without gateway) is marked late.
const LATE_MS = 60 * 60e3;
const MAX_CANDIDATES = 200;

/** Records → [{ lockId, kind, at }] (deduplicated, capped). Never throws. */
function alarmCandidates(records, { now = Date.now() } = {}) {
  const out = new Map();
  for (const r of [].concat(records || [])) {
    if (!r || typeof r !== 'object') continue;
    const type = ALARM_TYPES[Number(r.recordTypeFromLock ?? r.recordType)] || ALARM_TYPES[Number(r.recordType)];
    const lockId = Number(r.lockId);
    const at = Number(r.lockDate || r.serverDate);
    if (!type || !Number.isSafeInteger(lockId) || lockId <= 0 || !Number.isFinite(at) || at <= 0 || at > now + 864e5) continue;
    const key = `${lockId}|${type.kind}|${at}`;
    if (!out.has(key)) out.set(key, { lockId, kind: type.kind, at: new Date(at).toISOString() });
    if (out.size >= MAX_CANDIDATES) break;
  }
  return [...out.values()];
}

module.exports = { ALARM_TYPES, KINDS, THROTTLE_MS, LATE_MS, alarmCandidates };
