/**
 * Time-to-revoke report — computed from the audit chain only.
 * ====================================================================
 * "When someone leaves, how long until their codes stop working?"
 * Clock starts at the trigger (operator suspend/delete, or the directory
 * deactivating/deleting the person) and stops when each of that person's
 * credentials is gone:
 *   remote   credential.auto_revoke / credential.revoke   (deleted via gateway)
 *   on-site  credential.pending_removal → credential.removed_on_site
 * Anything not finished yet is an OPEN item with its age — those are the
 * doors a leaver can still open, so they matter more than the averages.
 *
 * Because the audit chain is tamper-evident, so is this metric: it can go
 * into an ISO 27001 / SOC 2 evidence pack as-is.
 */
const TRIGGERS = {
  'users.suspend': 'suspended by operator',
  'users.delete': 'deleted by operator',
  'scim.user_deactivate': 'deactivated in directory',
  'scim.user_delete': 'deleted in directory',
};
const REMOTE = new Set(['credential.auto_revoke', 'credential.revoke']);
const CRED_DETAIL = /^(\S+) lock (\d+) user (\S+?)(?::|$)/;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]; // nearest rank
}
const stats = values => {
  const s = [...values].sort((a, b) => a - b);
  return { count: s.length, p50Sec: percentile(s, 50), p95Sec: percentile(s, 95), maxSec: s.length ? s[s.length - 1] : null };
};

/**
 * @param events  audit entries, any order ({ts, action, detail})
 * @param credentials current credential rows (for failed revokes / still-active codes)
 * @param lockVisible lockId → boolean (operator site scope)
 */
function revocationReport(events, { credentials = [], now = Date.now(), since = 0, lockVisible = () => true } = {}) {
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const lastTrigger = new Map(); // userId → {at, kind}
  const triggers = [];
  const items = new Map(); // credentialId → item
  const secs = (from, to) => Math.max(0, Math.round((to - from) / 1000));

  for (const e of sorted) {
    const at = Date.parse(e.ts);
    if (TRIGGERS[e.action]) {
      const userId = String(e.detail || '').split(' ')[0];
      if (!userId) continue;
      lastTrigger.set(userId, { at, kind: TRIGGERS[e.action], action: e.action });
      if (at >= since) triggers.push({ userId, at, kind: TRIGGERS[e.action] });
      continue;
    }
    const m = String(e.detail || '').match(CRED_DETAIL);
    if (!m) continue;
    const [, credentialId, lockId, userId] = m;
    const trig = lastTrigger.get(userId);
    if (!trig || trig.at < since) continue;
    if (REMOTE.has(e.action) || e.action === 'credential.pending_removal') {
      if (items.has(credentialId)) continue;
      const item = { credentialId, lockId: Number(lockId), userId, trigger: trig.kind, triggeredAt: new Date(trig.at).toISOString() };
      if (REMOTE.has(e.action)) Object.assign(item, { outcome: 'remote', completedAt: e.ts, latencySec: secs(trig.at, at) });
      else Object.assign(item, { outcome: 'open_onsite', pendingSince: e.ts, remoteStepSec: secs(trig.at, at) });
      items.set(credentialId, item);
    } else if (e.action === 'credential.removed_on_site') {
      const item = items.get(credentialId);
      if (item && item.outcome === 'open_onsite') Object.assign(item, { outcome: 'onsite', completedAt: e.ts, latencySec: secs(trig.at, at) });
    }
  }

  // Codes of triggered people that are STILL active (vendor call failed, or
  // the reconciler has not run yet) — the worst case, surfaced first.
  const triggeredUsers = new Map(triggers.map(t => [t.userId, t]));
  for (const c of credentials) {
    if (c.status !== 'active' || items.has(c.id)) continue;
    const t = lastTrigger.get(c.userId);
    if (!t || t.at < since || !triggeredUsers.has(c.userId)) continue;
    if (Date.parse(c.issuedAt || 0) > t.at) continue; // issued after the trigger (e.g. reinstated) — not a leftover
    items.set(c.id, { credentialId: c.id, lockId: Number(c.lockId), userId: c.userId, trigger: t.kind, triggeredAt: new Date(t.at).toISOString(), outcome: 'open_remote' });
  }

  const visible = [...items.values()].filter(i => lockVisible(i.lockId));
  const open = visible.filter(i => i.outcome.startsWith('open_'))
    .map(i => ({ ...i, ageSec: secs(Date.parse(i.triggeredAt), now) }))
    .sort((a, b) => (a.outcome === b.outcome ? b.ageSec - a.ageSec : a.outcome === 'open_remote' ? -1 : 1));
  return {
    since: new Date(since).toISOString(),
    triggers: triggers.length,
    credentials: visible.length,
    remote: stats(visible.filter(i => i.outcome === 'remote').map(i => i.latencySec)),
    onsite: stats(visible.filter(i => i.outcome === 'onsite').map(i => i.latencySec)),
    open: { count: open.length, stillActive: open.filter(i => i.outcome === 'open_remote').length, oldestSec: open.length ? Math.max(...open.map(i => i.ageSec)) : null, items: open.slice(0, 50) },
    items: visible.filter(i => !i.outcome.startsWith('open_')).slice(-100),
  };
}

module.exports = { revocationReport, percentile, TRIGGERS };
