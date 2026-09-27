/**
 * AccessX API — one implementation for both runtimes.
 * ====================================================================
 * server.js (Express + node:sqlite) and worker.js (Cloudflare + D1) are
 * thin adapters: they turn their native request into
 *   { method, path, query, body, headers, ip }
 * call api.handle(), and send back { status, body }.
 *
 * Every request is bound to exactly one tenant — the operator's — before
 * any handler runs. Handlers read a tenant snapshot and write through a
 * unit of work, so each change and its audit entry commit together.
 */
const rbac = require('./rbac-core');
const policy = require('./policy-core');
const creds = require('./credentials-core');
const visitors = require('./visitors-core');
const lockEvents = require('./lock-events-core');
const health = require('./lock-health-core');
const onboarding = require('./onboarding-core');
const billingCore = require('./billing-core');
const compiler = require('./compiler-core');
const reconciler = require('./reconcile-core');
const { validate, ValidationError, escapeHtml: h, referencedBy } = require('./validate-core');
const { sha256Hex } = require('./audit-core');
const { operatorStatement } = require('./store/repo');
const { sessionCookie, clearSessionCookies, flowCookie, flowStateFrom } = require('./cookies');
const { createOidcClient, randomB64url } = require('./oidc-core');
const { encryptSecret, decryptSecret, codeMac, codeMacs } = require('./secrets-core');
const { segments: smsSegments, normalizePhone } = require('./sms-core');
const { createSecretsRotation } = require('./secrets-rotation');
const { revocationReport } = require('./reports-core');
const { createScim, membershipChanges, errorBody: scimErrorBody, CONTENT_TYPE: SCIM_TYPE } = require('./scim-core');
const { seedTenant } = require('./store/bootstrap');

class HttpError extends Error {
  constructor(status, error, extra = {}) { super(error); this.status = status; this.extra = extra; }
}
const forbiddenSite = lockId => new HttpError(403, 'forbidden', { required: 'site scope', detail: `lock ${lockId} is outside your sites` });
const outOfScope = detail => new HttpError(403, 'forbidden', { required: 'site scope', detail });

const COLLECTIONS = ['sites', 'doorGroups', 'userGroups', 'users', 'schedules', 'assignments', 'holidays', 'roles'];
/** Collections whose records hold personal data: audit details carry ids only. */
const PERSONAL = new Set(['users']);

function randomToken(bytes = 24) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Site scope helpers (operators limited to some sites)                 */
/* ------------------------------------------------------------------ */
function scopeFor(snap, op) {
  const all = rbac.allSites(op);
  const site = id => rbac.canAccessSite(op, id);
  const group = gid => {
    if (all) return true;
    const g = (snap.userGroups || []).find(x => x.id === gid);
    return Boolean(g && g.siteId && site(g.siteId));
  };
  const doorGroup = dgid => {
    const dg = (snap.doorGroups || []).find(x => x.id === dgid);
    return all || Boolean(dg && site(dg.siteId));
  };
  return {
    all,
    site,
    group,
    doorGroup,
    lock: lockId => rbac.canAccessLock(snap, op, lockId),
    /** sees a user if they belong to at least one group in scope */
    userVisible: u => all || (u.groupIds || []).some(group),
    /** may change/delete a user only if EVERY group is in scope —
     *  a gym manager must not be able to suspend an office employee who
     *  also happens to hold a gym membership */
    userManageable: u => all || ((u.groupIds || []).length > 0 && u.groupIds.every(group)),
    filter(collection, items) {
      if (all) return items;
      switch (collection) {
        case 'sites': return items.filter(s => site(s.id));
        case 'doorGroups': return items.filter(d => site(d.siteId));
        case 'userGroups': return items.filter(g => group(g.id));
        case 'users': return items.filter(u => (u.groupIds || []).some(group));
        case 'assignments': return items.filter(a => doorGroup(a.doorGroupId) && group(a.userGroupId));
        case 'holidays': return items.filter(x => !x.siteId || site(x.siteId));
        default: return items; // schedules, roles: tenant-wide definitions
      }
    },
    /** may this operator create/delete this record? */
    canWrite(collection, item) {
      if (all) return true;
      switch (collection) {
        case 'users': return (item.groupIds || []).length > 0 && item.groupIds.every(group);
        case 'doorGroups': return site(item.siteId);
        case 'userGroups': return Boolean(item.siteId) && site(item.siteId);
        case 'holidays': return Boolean(item.siteId) && site(item.siteId);
        case 'assignments': return doorGroup(item.doorGroupId) && group(item.userGroupId);
        default: return false; // sites, schedules, roles need all-site scope
      }
    },
  };
}

/** Audit detail for a created record — personal data never enters the chain. */
function createDetail(collection, item) {
  if (PERSONAL.has(collection)) {
    const fields = Object.keys(item).filter(k => k !== 'id').sort();
    return `${item.id} groups=${(item.groupIds || []).join(',') || '-'} fields=${fields.join(',')}`;
  }
  return JSON.stringify(item).slice(0, 200);
}

const EMAIL_RE = /^[^\s@<>"']{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;
const DOMAIN_RE = /^(?=.{3,190}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function createApi({
  store, auth, vendorFor, ensureReady = async () => {}, log = () => {}, cookieSameSite = 'Lax',
  secretsKey = '', ttlockNotifySecret = '', publicUrl = '', smsMonthlyCap = 0, fetchFn, allowHttpIssuers = false, oidc = createOidcClient({ fetchFn, allowPrivate: allowHttpIssuers }), vendorAccounts = null, auditOps = null, dns = null, alerts = null, sms = null, billing = null,
  // Runs a tenant's background work in that tenant's write queue (tenant-queue.js).
  serialize = (tenantId, fn) => fn(),
}) {
  /** A tenant's own connected account wins; otherwise the adapter's default (demo / legacy env). */
  const resolveVendor = async tenantId => (vendorAccounts && await vendorAccounts.vendorFor(tenantId)) || vendorFor(tenantId);

  let ready = null;
  const whenReady = () => {
    if (!ready) ready = ensureReady().catch(error => { ready = null; throw error; });
    return ready;
  };

  const scim = createScim({
    uid: policy.uid,
    log,
    // Directory removed access → revoke now. Never fail the SCIM request:
    // the periodic reconcile is the safety net.
    reconcile: async (tenantId, userId) => {
      try { await reconcileTenant(tenantId, { userId, actor: reconciler.ACTOR }); } catch (error) { log('reconcile after SCIM failed', error); }
    },
  });

  /* ---------------------------------------------------------------- */
  /* Reconciliation                                                    */
  /* ---------------------------------------------------------------- */
  const slaOf = snap => ((snap.settings || {}).alerts || {}).slaHours || reconciler.REMOVAL_SLA_HOURS;

  async function reconcileTenant(tenantId, { userId = null, lockFilter = () => true, dryRun = false, actor } = {}) {
    const t = store.tenant(tenantId);
    const vendor = await resolveVendor(tenantId);
    const [snap, locks] = await Promise.all([t.snapshot(), vendor.listLocks()]);
    const slaHours = slaOf(snap);
    const planned = reconciler.plan(snap, locks, { userId, lockFilter, slaHours });
    const overdue = planned.notices.filter(n => n.type === 'removal_overdue');
    // Escalate each overdue on-site removal once (the audit entry is the marker).
    let fresh = [];
    if (overdue.length && !dryRun) {
      const done = new Set((await t.auditRecent({ action: 'credential.removal_overdue', limit: 1000 })).map(e => String(e.detail).split(' ')[0]));
      fresh = overdue.filter(n => !done.has(n.credentialId));
    }
    if (dryRun || (!planned.actions.length && !fresh.length)) return { dryRun, plan: planned, summary: { revoked: 0, expired: 0, pendingRemoval: 0, failed: 0, overdue: overdue.length, escalated: 0 } };
    const uow = t.unit();
    const outcome = planned.actions.length ? await reconciler.execute(planned, { vendor, uow, snapshot: snap, actor }) : { summary: { revoked: 0, expired: 0, pendingRemoval: 0, failed: 0 }, results: [] };
    for (const n of fresh) uow.audit('credential.removal_overdue', `${n.credentialId} lock ${n.lockId} user ${n.userId} still on the lock after ${n.ageHours} h (SLA ${n.slaHours} h)`, reconciler.ACTOR);
    const failedNow = outcome.results.filter(r => !r.ok);
    const failedBefore = failedNow.length
      ? new Set((await t.auditRecent({ action: 'credential.revoke_failed', limit: 1000 })).map(e => String(e.detail).split(' ')[0]))
      : new Set();
    await uow.commit();
    // Tell a human (best effort, never fails the run): each overdue removal and
    // each credential's first failed revoke, once.
    if (alerts) {
      const name = id => ((snap.users || []).find(u => u.id === id) || {}).name || id;
      const door = id => { const c = (locks || []).find(l => Number(l.lockId) === Number(id)); return c ? `${c.lockAlias || c.name || id} (${id})` : String(id); };
      if (fresh.length) {
        await alerts.send(tenantId, 'removal_overdue', {
          title: `${fresh.length} code${fresh.length > 1 ? 's' : ''} still on offline locks past the ${slaHours} h removal target`,
          text: 'Access was revoked, but the lock cannot be reached from the cloud. Someone has to remove the code at the door and confirm it in AccessX.',
          facts: fresh.slice(0, 10).map(n => [door(n.lockId), `${name(n.userId)} — revoked ${n.ageHours} h ago`]),
          path: '/#reports',
        });
      }
      const newFailures = failedNow.filter(r => !failedBefore.has(r.credentialId));
      if (newFailures.length) {
        const creds = snap.credentials || [];
        await alerts.send(tenantId, 'revoke_failed', {
          title: `Could not revoke ${newFailures.length} code${newFailures.length > 1 ? 's' : ''} — ${newFailures.length > 1 ? 'they' : 'it'} still work${newFailures.length > 1 ? '' : 's'}`,
          text: 'AccessX keeps retrying every 15 minutes. If the lock or its gateway is offline, remove the code on site.',
          facts: newFailures.slice(0, 10).map(r => { const c = creds.find(x => x.id === r.credentialId) || {}; return [door(c.lockId), `${name(c.userId)}: ${String(r.error).slice(0, 120)}`]; }),
          path: '/#reports',
        });
      }
    }
    return { dryRun, plan: planned, ...outcome, summary: { ...outcome.summary, overdue: overdue.length, escalated: fresh.length } };
  }

  /** Run after a write that can remove access. Never fails the request:
   *  the periodic job is the safety net. */
  async function reconcileAfter(ctx, opts) {
    try {
      const out = await reconcileTenant(ctx.tenantId, { ...opts, actor: reconciler.ACTOR });
      return out.summary;
    } catch (error) {
      log('reconcile after write failed', error);
      return { error: 'reconcile deferred to the next scheduled run' };
    }
  }

  /** Scheduled reconcile of one tenant (never throws). */
  async function reconcileOne(tenantId) {
    try {
      const out = await reconcileTenant(tenantId, { actor: reconciler.ACTOR });
      return { tenantId, ...out.summary, notices: out.plan.notices.length };
    } catch (error) {
      log(`reconcile ${tenantId} failed`, error);
      return { tenantId, error: String(error.message || error) };
    }
  }

  async function tenantIds() {
    await whenReady();
    return (await store.listTenants()).filter(t => t.seeded).map(t => t.id);
  }

  async function reconcileAll() {
    const results = [];
    for (const id of await tenantIds()) results.push(await serialize(id, () => reconcileOne(id)));
    return results;
  }

  /* ---------------------------------------------------------------- */
  /* Routes                                                            */
  /* ---------------------------------------------------------------- */
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

  // --- identity ------------------------------------------------------
  route('POST', /^\/api\/auth\/verify$/, async ctx => ({ authenticated: true, operator: rbac.describe(await ctx.snap(), ctx.operator), tenant: (await ctx.snap()).tenant }));
  route('GET', /^\/api\/me$/, async ctx => ({ operator: rbac.describe(await ctx.snap(), ctx.operator), tenant: (await ctx.snap()).tenant }));
  route('GET', /^\/api\/permissions$/, async ctx => {
    // Built-in roles added after a tenant was created (e.g. r_front_desk) are assignable too.
    const stored = (await ctx.snap()).roles;
    return { perms: rbac.PERMS, roles: [...stored, ...rbac.DEFAULT_ROLES.filter(d => !stored.some(r => r.id === d.id)).map(d => ({ ...d, builtIn: true }))] };
  });
  route('GET', /^\/api\/status$/, async ctx => ({ ...ctx.vendor.status(), tenant: (await ctx.snap()).tenant }));

  // --- doors ---------------------------------------------------------
  route('GET', /^\/api\/doors$/, async ctx => {
    const snap = await ctx.snap();
    const sensitive = sensitiveLockSet(snap);
    const doors = (await ctx.visibleLocks()).map(l => {
      const dg = snap.doorGroups.find(d => (d.lockIds || []).map(Number).includes(Number(l.lockId)));
      const site = dg ? snap.sites.find(s => s.id === dg.siteId) : null;
      // timeZone: the zone every door-local time (endLocal, localTime, schedules)
      // is read in, so the UI can label and prefill in the door's time, not the browser's.
      return { ...l, doorGroup: dg ? dg.name : null, site: site ? site.name : (l.groupName || 'Unassigned'), siteId: site ? site.id : null, timeZone: policy.siteTimeZone(snap, site ? site.id : null), sensitive: sensitive.has(Number(l.lockId)) };
    });
    return { doors };
  });

  route('POST', /^\/api\/doors\/(\d+)\/unlock$/, async (ctx, [lockParam]) => {
    const snap = await ctx.snap();
    const lockId = Number(lockParam);
    const { userId, reason } = ctx.body;
    await ctx.requireLock(lockId);
    if (!ctx.scope.lock(lockId)) throw forbiddenSite(lockId);
    const uow = ctx.t.unit();
    // ★ policy check BEFORE touching the lock — this is the whole point
    if (userId) {
      const v = policy.evaluate(snap, userId, lockId, new Date());
      if (!v.allowed) {
        await uow.audit('unlock.denied', `lock ${lockId} user ${userId}: ${v.reason}`, ctx.actor).commit();
        throw new HttpError(403, v.reason, { denied: true, reason: v.reason, path: v.path });
      }
    } else if (typeof reason !== 'string' || reason.trim().length < 3) {
      // An override bypasses every rule — make the operator say why, on the record.
      throw new HttpError(400, 'reason is required for an operator override unlock (or pass userId to check policy)');
    }
    if (!ctx.vendor.demo) await ctx.vendor.unlock(lockId);
    const detail = userId ? `lock ${lockId} user ${userId}` : `lock ${lockId} (operator override) reason: ${String(reason).trim().slice(0, 200)}`;
    await uow.audit('unlock.granted', detail, ctx.actor).commit();
    return { unlocked: lockId, simulated: ctx.vendor.demo };
  });

  // --- decisions -----------------------------------------------------
  route('POST', /^\/api\/evaluate$/, async ctx => {
    const snap = await ctx.snap();
    const { userId, lockId, when, localTime } = ctx.body;
    if (!ctx.scope.lock(lockId)) throw forbiddenSite(lockId);
    const site = policy.siteForLock(snap, lockId);
    const timeZone = policy.siteTimeZone(snap, site && site.id);
    // localTime = wall-clock time at the door's site ("2026-09-28T21:00");
    // when = absolute instant (ISO with offset). localTime wins if both sent.
    const at = localTime ? policy.zonedTimeToDate(localTime, timeZone) : when ? new Date(when) : new Date();
    if (Number.isNaN(at.getTime())) throw new HttpError(400, 'invalid date');
    return {
      at: at.toISOString(), site: site ? site.name : null, timeZone,
      localTime: policy.localParts(at, timeZone).label,
      result: policy.evaluate(snap, userId, Number(lockId), at),
    };
  });

  route('GET', /^\/api\/users\/([^/]+)\/doors$/, async (ctx, [userId]) => {
    const snap = await ctx.snap();
    const user = snap.users.find(u => u.id === userId);
    if (!user || !ctx.scope.userVisible(user)) throw new HttpError(404, 'not found');
    return { doors: policy.doorsForUser(snap, userId, new Date()).filter(d => ctx.scope.lock(d.lockId)) };
  });

  // --- people lifecycle ----------------------------------------------
  for (const [verb, suspended] of [['suspend', true], ['unsuspend', false]]) {
    route('POST', new RegExp(`^/api/users/([^/]+)/${verb}$`), async (ctx, [userId]) => {
      const snap = await ctx.snap();
      const user = snap.users.find(u => u.id === userId);
      if (!user || !ctx.scope.userVisible(user)) throw new HttpError(404, 'not found');
      if (!ctx.scope.userManageable(user)) throw outOfScope(`${userId} belongs to groups outside your sites`);
      if (!suspended && user.directoryStatus === 'inactive') {
        throw new HttpError(409, 'this person is deactivated in your directory; reactivate them there', { managedBy: 'directory' });
      }
      if (!suspended && user.suspended) {
        // Reinstating restores every door the person's groups reach. Without this,
        // "create suspended, then unsuspend" would bypass the new-user approval.
        const gate = await fourEyes(ctx, locksOfUserGroups(snap, user.groupIds || []), `reinstate suspended user ${userId} (groups ${(user.groupIds || []).join(',') || '-'})`);
        if (gate) return gate;
      }
      await ctx.t.unit().update('users', userId, { suspended }).audit(`users.${verb}`, userId, ctx.actor).commit();
      const reconcile = suspended ? await reconcileAfter(ctx, { userId }) : undefined;
      return { user: { ...user, suspended }, reconcile };
    });
  }

  /** GDPR Art. 15 subject access: everything we hold about one person. */
  route('GET', /^\/api\/users\/([^/]+)\/export$/, async (ctx, [userId]) => {
    const snap = await ctx.snap();
    const user = snap.users.find(u => u.id === userId);
    if (!user || !ctx.scope.userVisible(user)) throw new HttpError(404, 'not found');
    const events = [];
    for (let before = null; ;) {
      const page = await ctx.t.auditRecent({ limit: 1000, before });
      events.push(...page.filter(e => new RegExp(`\\b${userId}\\b`).test(e.detail) || e.actor === userId));
      if (page.length < 1000) break;
      before = page[page.length - 1].seq;
    }
    await ctx.t.unit().audit('users.export', userId, ctx.actor).commit();
    return {
      exportedAt: new Date().toISOString(),
      user,
      groups: snap.userGroups.filter(g => (user.groupIds || []).includes(g.id)),
      credentials: snap.credentials.filter(c => c.userId === userId),
      auditEvents: events,
    };
  });

  // --- four-eyes approvals ------------------------------------------------------
  /**
   * New access to a sensitive door needs a second person. The original
   * request is stored; when a different operator with the same permission
   * approves, it is re-run AS THE REQUESTER against current data (so every
   * validation, policy and scope check happens again). 72 h expiry.
   * Removing access never needs approval.
   */
  const APPROVAL_TTL_MS = 72 * 3600e3;
  const sensitiveLockSet = snap => new Set(snap.doorGroups.filter(g => g.sensitive).flatMap(g => g.lockIds || []).map(Number));
  const locksOfUserGroups = (snap, ugIds) => {
    const dgs = new Set(snap.assignments.filter(a => ugIds.includes(a.userGroupId)).map(a => a.doorGroupId));
    return snap.doorGroups.filter(g => dgs.has(g.id)).flatMap(g => g.lockIds || []);
  };
  /**
   * Locks whose schedules would open on `holiday.date` once the holiday is
   * gone: assignments with a denyOnHolidays schedule, restricted to the
   * holiday's site (a holiday without a site applies everywhere). Past
   * holidays re-open nothing. One day of slack covers every time zone.
   */
  const locksReopenedBy = (snap, holiday) => {
    if (!holiday.date || holiday.date < new Date(Date.now() - 864e5).toISOString().slice(0, 10)) return [];
    const closing = new Set(snap.schedules.filter(s => s.denyOnHolidays).map(s => s.id));
    const dgIds = new Set(snap.assignments.filter(a => a.scheduleId && closing.has(a.scheduleId)).map(a => a.doorGroupId));
    const locks = snap.doorGroups.filter(g => dgIds.has(g.id)).flatMap(g => g.lockIds || []).map(Number);
    return [...new Set(locks)].filter(l => {
      if (!holiday.siteId) return true;
      const site = policy.siteForLock(snap, l);
      return site && site.id === holiday.siteId;
    });
  };
  const rowToApproval = r => {
    const payload = JSON.parse(r.payload);
    return {
      id: r.id, summary: r.summary, locks: JSON.parse(r.locks), request: { method: payload.method, path: payload.path },
      requestedBy: r.requested_by, requestedAt: r.requested_at, expiresAt: r.expires_at, status: r.status,
      decidedBy: r.decided_by || null, decidedAt: r.decided_at || null, note: r.note || null, result: r.result ? JSON.parse(r.result) : null,
      codeWaiting: Boolean(r.sealed_code), collectedAt: r.collected_at || null,
    };
  };

  /** Returns a 202 response body when approval is needed, else null. */
  async function fourEyes(ctx, lockIds, summary, { issuesCode = false } = {}) {
    if (ctx.approval) return null; // this IS the approved execution
    const sensitive = sensitiveLockSet(await ctx.snap());
    const hit = [...new Set((lockIds || []).map(Number).filter(id => sensitive.has(id)))];
    if (!hit.length) return null;
    if (issuesCode && !secretsKey) {
      // Fail closed: without a key the code could only be handed to the approver,
      // which defeats four-eyes (the approver would hold a working code).
      throw new HttpError(503, 'Passcodes for sensitive doors need SECRETS_KEY on the server: the approved code is sealed so that only the requester can read it.', { reason: 'secrets_key_missing' });
    }
    const now = Date.now();
    const approval = { id: policy.uid('apr'), summary, locks: hit, request: { method: ctx.method, path: ctx.path }, requestedBy: ctx.actor, requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(), status: 'pending' };
    await ctx.t.unit()
      .raw('INSERT INTO approvals (tenant_id, id, summary, payload, locks, requested_by, requested_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [ctx.tenantId, approval.id, summary, JSON.stringify({ method: ctx.method, path: ctx.path, body: ctx.body }), JSON.stringify(hit), ctx.actor, approval.requestedAt, approval.expiresAt])
      .audit('approval.request', `${approval.id}: ${summary} [sensitive locks ${hit.join(',')}]`, ctx.actor)
      .commit();
    if (alerts) {
      await alerts.send(ctx.tenantId, 'approval_requested', {
        title: 'Approval needed: access to a sensitive door',
        text: `${ctx.operator && ctx.operator.name ? ctx.operator.name : ctx.actor} asked for: ${summary}. A different operator with the same permission must approve within 72 hours.`,
        facts: [['Doors', hit.join(', ')], ['Requested by', ctx.actor], ['Expires', approval.expiresAt]],
        path: '/#log',
      });
    }
    return { _status: 202, approvalRequired: true, approval, message: 'This grants access to a sensitive door: a second operator must approve it (within 72 hours).' };
  }

  async function expireApprovals(tenantId) {
    const now = new Date().toISOString();
    // A code nobody collected within the approval window is thrown away (the
    // credential stays; revoke/reissue if it is still needed).
    const uncollected = await store.sql.all('SELECT id FROM approvals WHERE tenant_id = ? AND sealed_code IS NOT NULL AND decided_at <= ?',
      [tenantId, new Date(Date.now() - APPROVAL_TTL_MS).toISOString()]);
    if (uncollected.length) {
      const u = store.tenant(tenantId).unit();
      for (const r of uncollected) u.raw('UPDATE approvals SET sealed_code = NULL WHERE tenant_id = ? AND id = ?', [tenantId, r.id]).audit('approval.code_discarded', `${r.id}: not collected within 72 h`, 'system');
      await u.commit();
    }
    const stale = await store.sql.all("SELECT id FROM approvals WHERE tenant_id = ? AND status = 'pending' AND expires_at <= ?", [tenantId, now]);
    if (!stale.length) return 0;
    const uow = store.tenant(tenantId).unit();
    for (const r of stale) {
      uow.raw("UPDATE approvals SET status = 'expired', decided_at = ? WHERE tenant_id = ? AND id = ? AND status = 'pending'", [now, tenantId, r.id]).audit('approval.expire', r.id, 'system');
    }
    await uow.commit();
    return stale.length;
  }
  const routeFor = payload => {
    const found = routes.find(r => r.method === payload.method && r.pattern.test(payload.path));
    return found ? { found, params: payload.path.match(found.pattern).slice(1).map(decodeURIComponent), perm: rbac.requiredPermission(payload.method, payload.path) } : null;
  };

  route('GET', /^\/api\/approvals$/, async ctx => {
    await expireApprovals(ctx.tenantId);
    const status = ctx.query.get('status') || 'pending';
    const rows = await store.sql.all(`SELECT * FROM approvals WHERE tenant_id = ?${status === 'all' ? '' : ' AND status = ?'} ORDER BY requested_at DESC LIMIT 100`,
      status === 'all' ? [ctx.tenantId] : [ctx.tenantId, status]);
    const snap = await ctx.snap();
    const list = rows.map(rowToApproval).filter(a => ctx.scope.all || a.locks.every(l => ctx.scope.lock(l)));
    return {
      approvals: list.map(a => {
        const r = routeFor(a.request);
        const canDecide = a.status === 'pending' && a.requestedBy !== ctx.actor && Boolean(r) && rbac.hasPermission(snap, ctx.operator, r.perm);
        return { ...a, canDecide, canCancel: a.status === 'pending' && a.requestedBy === ctx.actor };
      }),
      // Approved passcodes waiting for *this* operator (the requester) to collect.
      ready: (await store.sql.all("SELECT * FROM approvals WHERE tenant_id = ? AND requested_by = ? AND status = 'approved' AND sealed_code IS NOT NULL ORDER BY decided_at DESC LIMIT 50",
        [ctx.tenantId, ctx.actor])).map(rowToApproval),
    };
  });

  route('POST', /^\/api\/approvals\/([^/]+)\/(approve|reject|cancel)$/, async (ctx, [id, verb]) => {
    await expireApprovals(ctx.tenantId);
    const note = typeof ctx.body.note === 'string' && ctx.body.note.trim() ? ctx.body.note.trim().slice(0, 500) : null;
    // Decide under the tenant's audit head: two approvers racing → one wins, the other sees "already approved".
    const decided = await ctx.t.transact(async (snap, uow) => {
      const row = await store.sql.first('SELECT * FROM approvals WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
      if (!row) throw new HttpError(404, 'not found');
      const a = rowToApproval(row);
      if (!ctx.scope.all && a.locks.some(l => !ctx.scope.lock(l))) throw new HttpError(404, 'not found');
      if (a.status !== 'pending') throw new HttpError(409, `this request is already ${a.status}`);
      const r = routeFor(JSON.parse(row.payload));
      if (verb === 'cancel') {
        if (a.requestedBy !== ctx.actor) throw new HttpError(403, 'forbidden', { detail: 'only the requester can cancel' });
      } else {
        if (a.requestedBy === ctx.actor) throw new HttpError(403, 'forbidden', { detail: 'four-eyes: a different operator must decide' });
        if (!r || !rbac.hasPermission(snap, ctx.operator, r.perm)) throw new HttpError(403, 'forbidden', { detail: `deciding needs the ${r ? r.perm : '?'} permission` });
      }
      const status = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[verb];
      uow.raw("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE tenant_id = ? AND id = ? AND status = 'pending'",
        [status, ctx.actor, new Date().toISOString(), note, ctx.tenantId, id])
        .audit(`approval.${verb}`, `${id}: ${a.summary}${note ? ` — note: ${note}` : ''}`, ctx.actor);
      return { a, payload: JSON.parse(row.payload), r, status };
    });
    if (verb !== 'approve') return { approval: { ...decided.a, status: decided.status, decidedBy: ctx.actor, note } };

    // Execute as the requester, re-validated against current data.
    const fail = async message => {
      await ctx.t.unit().raw("UPDATE approvals SET status = 'failed', result = ? WHERE tenant_id = ? AND id = ?", [JSON.stringify({ error: message }), ctx.tenantId, id])
        .audit('approval.failed', `${id}: ${message}`, ctx.actor).commit();
      throw new HttpError(409, `approved, but the change could not be applied: ${message}`, { approvalId: id });
    };
    const requester = await auth.operatorFor(ctx.tenantId, decided.a.requestedBy);
    const snap = await ctx.t.snapshot();
    if (!requester) return fail('the requester no longer has access');
    if (!decided.r || !rbac.hasPermission(snap, requester, decided.r.perm)) return fail('the requester no longer holds the permission for this change');
    const reqCtx = buildCtx({ t: ctx.t, vendor: ctx.vendor, tenantId: ctx.tenantId, operator: requester, body: decided.payload.body || {}, query: new URLSearchParams(), origin: ctx.origin, method: decided.payload.method, path: decided.payload.path, approval: { id, approvedBy: ctx.actor } });
    reqCtx.scope = scopeFor(snap, requester);
    let out;
    try { out = await decided.r.found.fn(reqCtx, decided.r.params); } catch (e) { return fail(e.message || String(e)); }
    const brief = out && (out.item ? { item: out.item.id } : out.credential ? { credential: out.credential.id } : out.mapped ? { mapped: out.mapped } : {});
    let sealedCode = null;
    let result = out;
    if (out && out.passcode) {
      // Four-eyes means the approver must not hold a working code: seal it for
      // the requester (bound to tenant + approval id) and return only metadata.
      sealedCode = await encryptSecret(secretsKey, JSON.stringify(out.passcode), { tenantId: ctx.tenantId, purpose: `approval-code:${id}` });
      const { credential: c = {}, warnings = [] } = out;
      result = { credential: { id: c.id, lockId: c.lockId, userId: c.userId, startAt: c.startAt, endAt: c.endAt, status: c.status, issuedBy: c.issuedBy }, warnings, codeHeldFor: decided.a.requestedBy };
    }
    await ctx.t.unit().raw('UPDATE approvals SET result = ?, sealed_code = ? WHERE tenant_id = ? AND id = ?', [JSON.stringify({ ok: true, ...brief }), sealedCode, ctx.tenantId, id]).commit();
    return { approval: { ...decided.a, status: 'approved', decidedBy: ctx.actor, note, result: { ok: true, ...brief }, codeWaiting: Boolean(sealedCode) }, result };
  });

  // The requester collects an approved passcode — once. The sealed copy is
  // wiped in the same transaction that audits the collection.
  route('POST', /^\/api\/approvals\/([^/]+)\/collect$/, async (ctx, [id]) => {
    await expireApprovals(ctx.tenantId);
    const taken = await ctx.t.transact(async (snap, uow) => {
      const row = await store.sql.first('SELECT * FROM approvals WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
      if (!row || row.requested_by !== ctx.actor) throw new HttpError(404, 'not found'); // only the requester even learns it exists
      if (!row.sealed_code) throw new HttpError(410, row.collected_at ? `this code was already collected at ${row.collected_at}` : 'no code is waiting for this request', { collectedAt: row.collected_at || null });
      const at = new Date().toISOString();
      uow.raw('UPDATE approvals SET sealed_code = NULL, collected_at = ? WHERE tenant_id = ? AND id = ?', [at, ctx.tenantId, id])
        .audit('approval.collect', `${id}: passcode collected by the requester`, ctx.actor);
      return { sealed: row.sealed_code, result: row.result ? JSON.parse(row.result) : {} };
    });
    const passcode = JSON.parse(await decryptSecret(secretsKey, taken.sealed, { tenantId: ctx.tenantId, purpose: `approval-code:${id}` }));
    const credential = taken.result.credential ? (await ctx.snap()).credentials.find(c => c.id === taken.result.credential) || null : null;
    return { passcode, credential, message: 'Shown once. It is not stored anywhere any more.' };
  });

  // --- collections (CRUD) ----------------------------------------------
  for (const coll of COLLECTIONS) {
    route('GET', new RegExp(`^/api/${coll}$`), async ctx => ({ [coll]: ctx.scope.filter(coll, (await ctx.snap())[coll]) }));

    route('POST', new RegExp(`^/api/${coll}$`), async ctx => {
      const snap = await ctx.snap();
      const clean = validate(coll, ctx.body, snap);
      if (!ctx.scope.canWrite(coll, clean)) {
        throw outOfScope(coll === 'users' ? 'every groupId must belong to one of your sites' : `creating ${coll} here needs all-site scope`);
      }
      if (coll === 'doorGroups') requireLocksInScope(ctx, clean.lockIds);
      let gate = null;
      if (coll === 'assignments') {
        gate = await fourEyes(ctx, (snap.doorGroups.find(g => g.id === clean.doorGroupId) || {}).lockIds, `assignment: user group ${clean.userGroupId} -> door group ${clean.doorGroupId}`);
      } else if (coll === 'users' && (clean.groupIds || []).length && !clean.suspended) {
        gate = await fourEyes(ctx, locksOfUserGroups(snap, clean.groupIds), `new user in groups ${clean.groupIds.join(',')}`);
      } else if (coll === 'doorGroups' && !clean.sensitive) {
        gate = await fourEyes(ctx, clean.lockIds, `door group "${clean.name}" (not marked sensitive) containing sensitive locks`);
      }
      if (gate) return gate;
      const item = { ...clean, id: policy.uid(coll.slice(0, 3)) }; // server owns ids
      await ctx.t.unit().insert(coll, item).audit(`${coll}.create`, createDetail(coll, item) + (ctx.approval ? ` (approval ${ctx.approval.id} by ${ctx.approval.approvedBy})` : ''), ctx.actor).commit();
      return { item };
    });

    route('DELETE', new RegExp(`^/api/${coll}/([^/]+)$`), async (ctx, [id]) => {
      const snap = await ctx.snap();
      const item = snap[coll].find(x => x.id === id);
      if (!item || (coll === 'users' && !ctx.scope.userVisible(item))) throw new HttpError(404, 'not found');
      if (coll === 'users' ? !ctx.scope.userManageable(item) : !ctx.scope.canWrite(coll, item)) {
        throw outOfScope(`${id} is (partly) outside your sites`);
      }
      if (coll === 'users' && item.source === 'scim') {
        throw new HttpError(409, 'this person is managed by your directory (SCIM); remove them there', { managedBy: 'directory' });
      }
      const refs = referencedBy(coll, id, snap);
      if (refs.length) throw new HttpError(409, 'still referenced', { referencedBy: refs.slice(0, 20) });
      if (coll === 'doorGroups' && item.sensitive) {
        // Removing the protection itself needs a second person.
        const gate = await fourEyes(ctx, item.lockIds, `delete sensitive door group ${id}`);
        if (gate) return gate;
      }
      if (coll === 'holidays') {
        // A holiday closes doors on schedules with denyOnHolidays: deleting a
        // future one widens those schedules' hours.
        const gate = await fourEyes(ctx, locksReopenedBy(snap, item), `delete holiday ${item.date}${item.name ? ` "${item.name}"` : ''} (re-opens doors closed on that day)`);
        if (gate) return gate;
      }
      // Deleting the row IS the erasure: name/email exist nowhere else
      // (audit entries reference the id only).
      await ctx.t.unit().remove(coll, id)
        .audit(`${coll}.delete`, PERSONAL.has(coll) ? `${id} (personal data erased)` : id, ctx.actor).commit();
      let reconcile;
      if (coll === 'users') reconcile = await reconcileAfter(ctx, { userId: id });
      else if (['assignments', 'doorGroups', 'userGroups', 'schedules'].includes(coll)) reconcile = await reconcileAfter(ctx, {});
      return { reconcile };
    });
  }

  /**
   * A site-scoped operator may only put doors into door groups that are
   * already theirs. Door-group membership is what places a door in a site, so
   * without this a gym admin could file the office front door under the gym
   * and grant it to their own people.
   */
  function requireLocksInScope(ctx, lockIds) {
    if (ctx.scope.all) return;
    const foreign = (lockIds || []).filter(id => !ctx.scope.lock(id));
    if (foreign.length) throw outOfScope(`door(s) ${foreign.join(', ')} are not in your sites; only an all-site operator can add them to a door group`);
  }

  // Edit a door group: rename, add/remove doors, mark (un)sensitive. The site
  // cannot change (create a new group instead). Four-eyes applies to every
  // change that widens access to a sensitive door or removes its protection;
  // narrowing an ordinary group is immediate and triggers a reconcile.
  route('PATCH', /^\/api\/doorGroups\/([^/]+)$/, async (ctx, [id]) => {
    const snap = await ctx.snap();
    const item = snap.doorGroups.find(x => x.id === id);
    if (!item || !ctx.scope.filter('doorGroups', [item]).length) throw new HttpError(404, 'not found');
    if (!ctx.scope.canWrite('doorGroups', item)) throw outOfScope(`${id} is outside your sites`);
    const b = ctx.body || {};
    const unknown = Object.keys(b).filter(k => !['name', 'lockIds', 'sensitive'].includes(k));
    if (unknown.length) throw new HttpError(400, `only name, lockIds and sensitive can change (${unknown.join(', ')}); to move a group to another site, create a new one`);
    const next = validate('doorGroups', {
      name: 'name' in b ? b.name : item.name, siteId: item.siteId,
      lockIds: 'lockIds' in b ? b.lockIds : item.lockIds, sensitive: 'sensitive' in b ? b.sensitive : Boolean(item.sensitive),
    }, snap);
    next.sensitive = Boolean(next.sensitive);
    const before = new Set((item.lockIds || []).map(Number));
    const after = new Set(next.lockIds);
    const added = next.lockIds.filter(l => !before.has(l));
    const removed = [...before].filter(l => !after.has(l));
    requireLocksInScope(ctx, added);
    const wasSensitive = Boolean(item.sensitive);
    const changes = [];
    if (next.name !== item.name) changes.push(`name "${item.name}" -> "${next.name}"`);
    if (added.length) changes.push(`+doors ${added.join(',')}`);
    if (removed.length) changes.push(`-doors ${removed.join(',')}`);
    if (next.sensitive !== wasSensitive) changes.push(next.sensitive ? 'marked sensitive' : 'no longer sensitive');
    if (!changes.length) return { item, message: 'Nothing changed.' };
    const gateLocks = [...added, ...(wasSensitive ? removed : []), ...(wasSensitive && !next.sensitive ? next.lockIds : [])];
    const gate = await fourEyes(ctx, gateLocks, `door group "${item.name}": ${changes.join('; ')}`);
    if (gate) return gate;
    const updated = { ...item, name: next.name, lockIds: next.lockIds, sensitive: next.sensitive };
    await ctx.t.unit().update('doorGroups', id, { name: next.name, lockIds: next.lockIds, sensitive: next.sensitive })
      .audit('doorGroups.update', `${id}: ${changes.join('; ')}` + (ctx.approval ? ` (approval ${ctx.approval.id} by ${ctx.approval.approvedBy})` : ''), ctx.actor).commit();
    const reconcile = removed.length ? await reconcileAfter(ctx, {}) : undefined;
    return { item: updated, reconcile };
  });

  // --- credentials -----------------------------------------------------
  route('POST', /^\/api\/passcode$/, async ctx => {
    const snap = await ctx.snap();
    const { lockId, name, userId, acknowledgeScheduleGap } = ctx.body;
    let { endAt } = ctx.body;
    if (lockId === undefined || lockId === null || lockId === '') throw new HttpError(400, 'lockId is required');
    let { startAt } = ctx.body;
    // startLocal / endLocal = wall-clock time AT THE DOOR ("2026-10-31T08:00"), not in the admin's browser.
    // A later start matters on TTLock: a period code must be used within 24 h of its start or the lock voids it.
    const site = policy.siteForLock(snap, lockId);
    const tz = policy.siteTimeZone(snap, site ? site.id : null);
    const atDoor = (v, name) => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v))) throw new HttpError(400, `${name} must look like 2026-10-31T08:00 (time at the door)`);
      const t = policy.zonedTimeToDate(String(v), tz, { prefer: name === 'startLocal' ? 'later' : 'earlier' });
      if (Number.isNaN(t.getTime())) throw new HttpError(400, `${name} is not a valid time`);
      return t.toISOString();
    };
    if (ctx.body.startLocal !== undefined && ctx.body.startLocal !== '') startAt = atDoor(ctx.body.startLocal, 'startLocal');
    if (ctx.body.endLocal !== undefined) endAt = atDoor(ctx.body.endLocal, 'endLocal');
    if (startAt && Date.parse(startAt) > Date.now() + 90 * 864e5) throw new HttpError(400, 'a passcode can start at most 90 days ahead');
    await ctx.requireLock(lockId);
    if (!ctx.scope.lock(lockId)) throw forbiddenSite(lockId);
    const user = snap.users.find(u => u.id === userId);
    if (user && !ctx.scope.userVisible(user)) throw new HttpError(404, 'unknown user');
    // ★ Policy check BEFORE the lock gets a code — same rule as remote unlock.
    const plan = creds.planPasscode(snap, { userId, lockId, startAt, endAt, acknowledgeScheduleGap: acknowledgeScheduleGap === true });
    if (!plan.ok) {
      await ctx.t.unit().audit('passcode.denied', `lock ${lockId} user ${userId}: ${plan.error}`, ctx.actor).commit();
      const { ok: _ok, status, error, ...rest } = plan;
      throw new HttpError(status, error, rest);
    }
    const c = plan.credential;
    const gate = await fourEyes(ctx, [c.lockId], `passcode: lock ${c.lockId} user ${userId} ${c.startAt}..${c.endAt}`, { issuesCode: true });
    if (gate) return gate;
    const out = await ctx.vendor.createPasscode({ lockId: c.lockId, name: String(name || `AccessX ${userId}`).slice(0, 100), startAt: c.startAt, endAt: c.endAt });
    const entry = creds.register({ credentials: [] }, c, { issuedBy: ctx.actor, vendorRef: out.keyboardPwdId, code: out.keyboardPwd });
    entry.vendorRef = entry.vendorRef === null || entry.vendorRef === undefined ? null : String(entry.vendorRef);
    await ctx.t.unit().insert('credentials', entry)
      .audit('passcode.create', `${entry.id} lock ${c.lockId} user ${userId} ${c.startAt}..${c.endAt} enforcement=${c.enforcement}` +
        (ctx.approval ? ` approval=${ctx.approval.id} approvedBy=${ctx.approval.approvedBy}` : '') +
        (plan.warnings.length ? ` warnings: ${plan.warnings.join(' | ')}` : ''), ctx.actor)
      .commit();
    // The full code is returned exactly once and never stored.
    return { passcode: out, credential: entry, warnings: plan.warnings };
  });

  // --- visitors ----------------------------------------------------------
  // A visit's codes are ordinary credentials (visitId set, userId = host), so
  // review, reconcile, removal SLA and the revocation report cover them.
  const emailAvailable = () => Boolean(alerts && alerts.emailAvailable);
  const smsAvailable = () => Boolean(sms && sms.available);
  // --- metered SMS (billing + monthly cap) ---
  const period = () => new Date().toISOString().slice(0, 7);
  async function smsUsage(tenantId) {
    const rows = await store.sql.all("SELECT kind, n FROM usage_counters WHERE tenant_id = ? AND period = ? AND kind IN ('sms', 'sms_segments')", [tenantId, period()]);
    const limits = (((await store.tenantSettings(tenantId)) || {}).limits) || {};
    const cap = Number.isInteger(limits.smsMonthlyCap) ? limits.smsMonthlyCap : smsMonthlyCap;
    const n = k => Number((rows.find(r => r.kind === k) || {}).n || 0);
    return { period: period(), sent: n('sms'), segments: n('sms_segments'), cap: cap || null };
  }
  /** One metered text (never queued). → 'delivered' | 'failed: …' | 'limit: …' */
  async function sendSms(tenantId, to, text) {
    const use = await smsUsage(tenantId);
    if (use.cap && use.sent >= use.cap) return `limit: this month's ${use.cap} text messages are used up`;
    const result = await sms.send(to, text);
    if (result === 'delivered') {
      const up = 'INSERT INTO usage_counters (tenant_id, period, kind, n) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, period, kind) DO UPDATE SET n = n + excluded.n';
      await store.sql.batch([{ sql: up, params: [tenantId, use.period, 'sms', 1] }, { sql: up, params: [tenantId, use.period, 'sms_segments', smsSegments(text)] }]).catch(error => log('sms usage', tenantId, error));
    }
    return result;
  }
  const doorName = (locks, id) => { const l = locks.find(x => Number(x.lockId) === Number(id)); return (l && l.lockAlias) || `Lock ${id}`; };
  const visitVisible = (ctx, v) => ctx.scope.all || v.lockIds.every(l => ctx.scope.lock(l));
  const visitView = (snap, v, now = Date.now()) => {
    const host = snap.users.find(u => u.id === v.hostUserId);
    const site = snap.sites.find(x => x.id === v.siteId);
    return {
      ...v, state: visitors.stateOf(v, now), hostName: host ? host.name : null, siteName: site ? site.name : null,
      timeZone: policy.siteTimeZone(snap, v.siteId),
      codes: snap.credentials.filter(c => c.visitId === v.id).map(c => ({ credentialId: c.id, lockId: c.lockId, status: c.status, codeHint: c.codeHint })),
    };
  };
  async function loadVisit(ctx, id) {
    const row = await store.sql.first('SELECT * FROM visits WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    const v = row ? visitors.rowToVisit(row) : null;
    if (!v || !visitVisible(ctx, v)) throw new HttpError(404, 'not found');
    return v;
  }

  route('GET', /^\/api\/visits$/, async ctx => {
    const snap = await ctx.snap();
    const now = Date.now();
    const range = ctx.query.get('range') || 'current';
    // current = not over yet, or ended in the last 24 h; recent = last 30 days.
    const since = range === 'all' ? null : new Date(now - (range === 'recent' ? 30 : 1) * 864e5).toISOString();
    const rows = await store.sql.all(`SELECT * FROM visits WHERE tenant_id = ?${since ? ' AND end_at >= ?' : ''} ORDER BY start_at DESC LIMIT 200`,
      since ? [ctx.tenantId, since] : [ctx.tenantId]);
    return {
      visits: rows.map(visitors.rowToVisit).filter(v => visitVisible(ctx, v)).map(v => visitView(snap, v, now)),
      settings: { ...visitors.settingsOf(snap.settings), emailAvailable: emailAvailable(), smsAvailable: smsAvailable() },
    };
  });

  // Just enough to pick a host: the front desk has no report.read.
  route('GET', /^\/api\/visits\/hosts$/, async ctx => {
    const snap = await ctx.snap();
    return { hosts: snap.users.filter(u => !u.suspended && ctx.scope.userVisible(u)).map(u => ({ id: u.id, name: u.name })).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
  });

  // Arrival detection needs SECRETS_KEY (code fingerprints); the TTLock callback is optional (else polling).
  // lastCallbackAt: when TTLock last called back about one of this tenant's doors (pilot check).
  const arrivalInfo = async tenantId => ({
    enabled: Boolean(secretsKey), callback: Boolean(ttlockNotifySecret),
    lastCallbackAt: (((await store.tenantSettings(tenantId)) || {}).ttlockCallbackAt) || null,
  });
  const deliveryInfo = async tenantId => ({
    emailAvailable: emailAvailable(), smsAvailable: smsAvailable(), smsUsage: smsAvailable() ? await smsUsage(tenantId) : null,
    checkoutLinks: Boolean(publicUrl), limits: visitors.LIMITS, arrivals: await arrivalInfo(tenantId),
  });
  route('GET', /^\/api\/visits\/settings$/, async ctx => ({
    ...visitors.settingsOf((await ctx.snap()).settings), ...(await deliveryInfo(ctx.tenantId)),
  }));

  // Pilot check: one metered text to a number the owner chooses.
  route('POST', /^\/api\/visits\/sms-test$/, async ctx => {
    if (!smsAvailable()) throw new HttpError(400, 'SMS is not configured on this server (SMS_PROVIDER, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SMS_FROM)');
    const to = normalizePhone(ctx.body && ctx.body.to);
    if (!to) throw new HttpError(400, 'to must be an international number, e.g. +44 7700 900123');
    const snap = await ctx.snap();
    const result = await sendSms(ctx.tenantId, to, `AccessX test message for ${(snap.tenant && snap.tenant.name) || 'your account'}: visitor codes by text work.`);
    await ctx.t.unit().audit('visits.sms_test', result === 'delivered' ? 'delivered' : result.slice(0, 120), ctx.actor).commit();
    return { delivery: result, smsUsage: await smsUsage(ctx.tenantId) };
  });

  route('PUT', /^\/api\/visits\/settings$/, async ctx => {
    const v = visitors.validateSettings(ctx.body || {});
    if (!v.ok) throw new HttpError(400, v.error);
    const next = { ...visitors.settingsOf((await store.tenantSettings(ctx.tenantId)) || {}), ...v.value };
    // json_set: only this key, a concurrent SSO/alerts change is never overwritten.
    await ctx.t.unit().raw("UPDATE tenants SET settings = json_set(COALESCE(settings, '{}'), '$.visitors', json(?)) WHERE id = ?", [JSON.stringify(next), ctx.tenantId])
      .audit('visits.settings', `maxHours=${next.maxHours} retentionDays=${next.retentionDays} notifyHost=${next.notifyHost}`, ctx.actor).commit();
    return { ...next, ...(await deliveryInfo(ctx.tenantId)) };
  });

  // Shared by reception (POST /api/visits), invite submissions (as the inviting
  // operator, re-checked now) and invite approvals.
  const createVisit = async ctx => {
    const snap = await ctx.snap();
    const body = ctx.body || {};
    // Tenant fleet first (a lock id from another tenant is "unknown", never "forbidden").
    const lockIds = Array.isArray(body.lockIds) ? [...new Set(body.lockIds.map(Number))] : [];
    for (const id of lockIds.slice(0, visitors.LIMITS.maxDoors)) if (Number.isFinite(id)) await ctx.requireLock(id);
    const plan = visitors.planVisit(snap, body, {
      sensitive: sensitiveLockSet(snap), canSeeLock: id => ctx.scope.lock(id), canSeeUser: u => ctx.scope.userVisible(u),
    });
    if (!plan.ok) {
      const { ok: _ok, status, error, ...rest } = plan;
      throw new HttpError(status, error, rest);
    }
    const v = plan.visit;
    const id = policy.uid('vis');
    const locks = await ctx.vendor.listLocks();
    const created = [];
    try {
      for (const lockId of v.lockIds) {
        // Only the visit id goes to the lock vendor — no visitor name (data minimisation).
        const out = await ctx.vendor.createPasscode({ lockId, name: `AccessX visit ${id}`, startAt: v.startAt, endAt: v.endAt });
        created.push({ lockId, out });
      }
    } catch (error) {
      // Codes already on locks must not be left untracked: remove what we can, record the rest.
      const uow = ctx.t.unit();
      for (const { lockId, out } of created) {
        const lock = locks.find(l => Number(l.lockId) === lockId);
        let status = 'pending_removal';
        if (lock && lock.hasGateway) { try { await ctx.vendor.deletePasscode(lockId, out.keyboardPwdId); status = 'revoked'; } catch { /* stays pending_removal */ } }
        const entry = creds.register({ credentials: [] }, { type: 'passcode', userId: v.hostUserId, lockId, siteId: v.siteId, startAt: v.startAt, endAt: v.endAt, enforcement: creds.ENFORCEMENT.LOCK, rules: [`visitor (visit ${id}, creation failed)`] }, { issuedBy: ctx.actor, vendorRef: out.keyboardPwdId, code: out.keyboardPwd });
        Object.assign(entry, { vendorRef: out.keyboardPwdId === undefined || out.keyboardPwdId === null ? null : String(out.keyboardPwdId), visitId: id, status, revokedAt: new Date().toISOString(), revokedBy: ctx.actor, revokeReason: 'visit creation failed' });
        uow.insert('credentials', entry).audit(status === 'revoked' ? 'credential.revoke' : 'credential.pending_removal', `${entry.id} lock ${lockId} user ${v.hostUserId}: visit ${id} creation failed`, ctx.actor);
      }
      if (created.length) await uow.commit();
      throw error;
    }
    const now = new Date().toISOString();
    const host = plan.host;
    // Keyed fingerprints (not the codes) so the first unlock can be recognised as the arrival.
    const macs = {};
    for (const { lockId, out } of created) {
      const m = await codeMac(secretsKey, { tenantId: ctx.tenantId, lockId, code: out.keyboardPwd }).catch(() => null);
      if (m) macs[lockId] = m;
    }
    const uow = ctx.t.unit().raw(
      'INSERT INTO visits (tenant_id, id, visitor_name, visitor_email, visitor_phone, company, host_user_id, site_id, lock_ids, start_at, end_at, status, delivery, created_by, created_at, code_macs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ctx.tenantId, id, v.visitorName, v.visitorEmail, v.visitorPhone, v.company, v.hostUserId, v.siteId, JSON.stringify(v.lockIds), v.startAt, v.endAt, 'scheduled', 'shown', ctx.actor, now, Object.keys(macs).length ? JSON.stringify(macs) : null]);
    const entries = created.map(({ lockId, out }) => {
      const entry = creds.register({ credentials: [] }, {
        type: 'passcode', userId: v.hostUserId, lockId, siteId: v.siteId, startAt: v.startAt, endAt: v.endAt,
        enforcement: creds.ENFORCEMENT.LOCK, rules: [`visitor (host ${host.name || host.id})`], status: 'active',
      }, { issuedBy: ctx.actor, vendorRef: out.keyboardPwdId, code: out.keyboardPwd });
      entry.vendorRef = out.keyboardPwdId === undefined || out.keyboardPwdId === null ? null : String(out.keyboardPwdId);
      entry.visitId = id;
      uow.insert('credentials', entry).audit('passcode.create', `${entry.id} lock ${lockId} user ${v.hostUserId} visit ${id} ${v.startAt}..${v.endAt} enforcement=lock`, ctx.actor);
      return entry;
    });
    // No personal data in the audit chain: it cannot be erased later.
    uow.audit('visit.create', `${id} host ${v.hostUserId} locks ${v.lockIds.join(',')} ${v.startAt}..${v.endAt} credentials ${entries.map(e => e.id).join(',')}` +
      (plan.warnings.length ? ` warnings: ${plan.warnings.join(' | ')}` : ''), ctx.actor);
    await uow.commit();

    const codes = created.map(({ lockId, out }) => ({ lockId, door: doorName(locks, lockId), code: String(out.keyboardPwd) }));
    const warnings = [...plan.warnings];
    // Self check-out link (needs PUBLIC_URL): only a hash is stored; the token is in the URL fragment,
    // which browsers never send to a server (no access logs, no Referer).
    let checkoutUrl = null;
    if (publicUrl && (body.sendCode === true || body.sendSms === true || body.checkoutLink === true)) {
      const token = randomB64url(18);
      await store.sql.batch([{ sql: 'UPDATE visits SET checkout_token_hash = ? WHERE tenant_id = ? AND id = ?', params: [sha256Hex(`visit-checkout|${token}`), ctx.tenantId, id] }]);
      checkoutUrl = `${publicUrl.replace(/\/+$/, '')}/checkout#${token}`;
    }
    // Sent only AFTER the codes are recorded; never queued (a queue would store the code).
    const site = snap.sites.find(x => x.id === v.siteId);
    const doorsWithCodes = codes.map(c => ({ name: c.door, code: c.code }));
    const outcomes = [];
    const events = [];
    if (body.sendCode === true) {
      if (!v.visitorEmail) warnings.push('no visitor email: hand the code over yourself');
      else if (!emailAvailable()) warnings.push('email is not configured on this server: hand the code over yourself');
      else {
        const msg = visitors.invitationEmail({ visit: v, hostName: host.name || 'Your host', siteName: site ? site.name : null, doors: doorsWithCodes, timeZone: plan.timeZone, tenantName: snap.tenant && snap.tenant.name, checkoutUrl });
        const result = await alerts.emailTo(v.visitorEmail, msg, `visit-${id}`);
        outcomes.push(result === 'delivered' ? 'emailed' : 'email_failed');
        events.push(result === 'delivered' ? ['visit.code_emailed', id] : ['visit.email_failed', `${id}: ${result}`]);
        if (result !== 'delivered') warnings.push(`the email could not be sent (${result}): hand the code over yourself`);
      }
    }
    if (body.sendSms === true) {
      if (!v.visitorPhone) warnings.push('no visitor phone: hand the code over yourself');
      else if (!smsAvailable()) warnings.push('SMS is not configured on this server: hand the code over yourself');
      else {
        const result = await sendSms(ctx.tenantId, v.visitorPhone, visitors.invitationSms({ visit: v, siteName: site ? site.name : null, doors: doorsWithCodes, timeZone: plan.timeZone, checkoutUrl }));
        outcomes.push(result === 'delivered' ? 'texted' : 'sms_failed');
        events.push(result === 'delivered' ? ['visit.code_texted', id] : ['visit.sms_failed', `${id}: ${result}`]);
        if (result !== 'delivered') warnings.push(`the text message could not be sent (${result}): hand the code over yourself`);
      }
    }
    const delivery = outcomes.length ? outcomes.join('+') : 'shown';
    if (events.length) {
      const u = ctx.t.unit().raw('UPDATE visits SET delivery = ? WHERE tenant_id = ? AND id = ?', [delivery, ctx.tenantId, id]);
      for (const [action, detail] of events) u.audit(action, detail, ctx.actor);
      await u.commit();
    }
    const visit = { id, ...v, status: 'scheduled', delivery, createdBy: ctx.actor, createdAt: now, endedAt: null, endedBy: null, erased: false, erasedAt: null, arrivedAt: null, arrivedLock: null };
    // The codes are returned exactly once and never stored.
    return { visit: visitView({ ...snap, credentials: entries }, visit), codes, delivery, warnings, checkoutUrl };
  };
  route('POST', /^\/api\/visits$/, createVisit);

  /**
   * End a visit: delete its codes where the door has a gateway, mark the rest
   * for removal at the lock. Shared by reception (route) and the visitor's own
   * check-out link. Throws the vendor error after keeping what worked.
   */
  async function endVisit({ t, vendor, tenantId, actor }, v, verb) {
    const id = v.id;
    const snap = await t.snapshot();
    const locks = await vendor.listLocks();
    const at = new Date().toISOString();
    const reason = verb === 'cancel' ? 'visit cancelled' : 'visitor checked out';
    const uow = t.unit();
    const stillValid = [];
    let failure = null;
    for (const cred of snap.credentials.filter(c => c.visitId === id && c.status === 'active')) {
      const lock = locks.find(l => Number(l.lockId) === Number(cred.lockId));
      if (lock && lock.hasGateway) {
        try {
          if (cred.vendorRef) await vendor.deletePasscode(cred.lockId, cred.vendorRef);
        } catch (error) { failure = failure || error; continue; }
        uow.update('credentials', cred.id, { status: 'revoked', revokedAt: at, revokedBy: actor, revokeReason: reason })
          .audit('credential.revoke', `${cred.id} lock ${cred.lockId} user ${cred.userId} visit ${id}`, actor);
      } else {
        uow.update('credentials', cred.id, { status: 'pending_removal', revokedAt: at, revokedBy: actor, revokeReason: reason })
          .audit('credential.pending_removal', `${cred.id} lock ${cred.lockId} user ${cred.userId} visit ${id}: no gateway, on-site removal required`, actor);
        stillValid.push({ credentialId: cred.id, lockId: cred.lockId, door: doorName(locks, cred.lockId), until: cred.endAt });
      }
    }
    if (failure) {
      // Keep what worked; the visit stays open so a retry finishes the job (already-revoked codes are skipped).
      await uow.commit();
      throw failure;
    }
    const status = verb === 'cancel' ? 'cancelled' : 'checked_out';
    await uow.raw("UPDATE visits SET status = ?, ended_at = ?, ended_by = ?, checkout_token_hash = NULL WHERE tenant_id = ? AND id = ? AND status = 'scheduled'", [status, at, actor, tenantId, id])
      .audit(`visit.${verb}`, `${id}${actor === 'visitor' ? ' (self check-out)' : ''}${stillValid.length ? ` still valid on locks ${stillValid.map(s => s.lockId).join(',')} until removed on site` : ''}`, actor).commit();
    return { status, at, stillValid };
  }

  route('POST', /^\/api\/visits\/([^/]+)\/(checkout|cancel)$/, async (ctx, [id, verb]) => {
    const v = await loadVisit(ctx, id);
    if (v.status !== 'scheduled') throw new HttpError(409, `visit is already ${v.status.replace('_', ' ')}`);
    const { status, at, stillValid } = await endVisit({ t: ctx.t, vendor: ctx.vendor, tenantId: ctx.tenantId, actor: ctx.actor }, v, verb);
    const after = await ctx.t.snapshot();
    return {
      visit: visitView(after, { ...v, status, endedAt: at, endedBy: ctx.actor }),
      stillValid,
      warnings: stillValid.map(s => `${s.door} has no gateway: the code keeps working until ${s.until} unless removed at the lock (then confirm it under Access → Credentials)`),
    };
  });

  // --- visitor self check-out (public, token-only) -------------------------------
  const CHECKOUT_GRACE_MS = 3600e3;
  const tokenHash = token => sha256Hex(`visit-checkout|${token}`);
  const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(token);

  async function visitByToken(token) {
    if (!validToken(token)) return null;
    const row = await store.sql.first("SELECT * FROM visits WHERE checkout_token_hash = ? AND status = 'scheduled'", [tokenHash(token)]);
    if (!row || Date.now() > Date.parse(row.end_at) + CHECKOUT_GRACE_MS) return null;
    return row;
  }

  /** Inside the tenant's queue. Re-checks the token: the row may have changed since the lookup. */
  async function visitorCheckout(tenantId, job) {
    const row = await visitByToken(job.token);
    if (!row || row.tenant_id !== tenantId) return { ok: false, gone: true };
    const t = store.tenant(tenantId);
    const out = await endVisit({ t, vendor: await resolveVendor(tenantId), tenantId, actor: 'visitor' }, visitors.rowToVisit(row), 'checkout');
    return { ok: true, status: out.status, pendingAtDoor: out.stillValid.map(s => s.door) };
  }

  /**
   * POST /api/visit-checkout {token, action: 'status' | 'checkout'} — no login.
   * Can only end a visit (remove access), never show a code or a name.
   */
  async function visitCheckoutPublic(body, { dispatch = null } = {}) {
    const gone = { status: 404, body: { ok: false, error: 'This link is no longer valid. If you are still on site, please see reception.' } };
    await whenReady();
    const row = await visitByToken(body && body.token);
    if (!row) return gone;
    const tenantId = row.tenant_id;
    if (body.action === 'checkout') {
      const job = { type: 'checkout', token: body.token };
      const r = dispatch ? await dispatch(tenantId, job) : await serialize(tenantId, () => runTenantJob(tenantId, job));
      if (!r || !r.ok) return gone;
      return { status: 200, body: { ok: true, checkedOut: true, pendingAtDoor: r.pendingAtDoor || [] } };
    }
    const snap = await store.tenant(tenantId).snapshot();
    const v = visitors.rowToVisit(row);
    const tz = policy.siteTimeZone(snap, v.siteId);
    const site = snap.sites.find(x => x.id === v.siteId);
    const locks = await (await resolveVendor(tenantId)).listLocks().catch(() => []);
    const label = iso => policy.localParts(new Date(iso), tz).label;
    return { status: 200, body: {
      ok: true, site: site ? site.name : null, doors: v.lockIds.map(l => doorName(locks, l)),
      from: label(v.startAt), until: label(v.endAt), arrived: Boolean(v.arrivedAt),
    } };
  }

  // --- visitor pre-registration invites (docs/PREREGISTRATION.md) --------------------
  const inviteHash = token => sha256Hex(`visit-invite|${token}`);
  const inviteGone = { status: 404, body: { ok: false, error: 'This invitation is no longer valid. Please contact your host.' } };
  const inviteState = (inv, now = Date.now()) => (['open', 'submitted'].includes(inv.status) && Date.parse(inv.expiresAt) <= now ? 'expired' : inv.status);
  const siteIsSensitive = (snap, siteId) => snap.doorGroups.some(g => g.sensitive && g.siteId === siteId);
  const inviteView = (snap, inv) => {
    const host = snap.users.find(u => u.id === inv.hostUserId);
    const site = snap.sites.find(x => x.id === inv.siteId);
    return { ...inv, status: inviteState(inv), hostName: host ? host.name : null, siteName: site ? site.name : null };
  };
  async function loadInvite(ctx, id) {
    const row = await store.sql.first('SELECT * FROM visit_invites WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    const inv = row ? visitors.rowToInvite(row) : null;
    if (!inv || !visitVisible(ctx, inv)) throw new HttpError(404, 'not found');
    return inv;
  }
  /** The body POST /api/visits would get for this invite. */
  const inviteVisitBody = (inv, { name, company, startLocal }) => ({
    visitorName: name, company, hostUserId: inv.hostUserId, lockIds: inv.lockIds,
    ...(inv.channel === 'email' ? { visitorEmail: inv.contact, sendCode: true } : { visitorPhone: inv.contact, sendSms: true }),
    startLocal: startLocal || inv.startLocal, endLocal: inv.endLocal, checkoutLink: true,
  });
  /**
   * Create the visit and deliver the code to the invite's fixed address. The
   * code is never shown to whoever holds the link: if delivery fails, the visit
   * is cancelled again at once (its codes removed) and the caller gets an error.
   */
  async function visitFromInvite(ctx, inv, details) {
    const saved = ctx.body;
    ctx.body = inviteVisitBody(inv, details);
    let out;
    try { out = await createVisit(ctx); } finally { ctx.body = saved; }
    if (/emailed|texted/.test(out.delivery)) return { ok: true, out };
    await endVisit({ t: ctx.t, vendor: ctx.vendor, tenantId: ctx.tenantId, actor: ctx.actor }, { id: out.visit.id }, 'cancel').catch(error => log('cancel undelivered invite visit', error));
    return { ok: false, reason: (out.warnings || []).find(w => /could not be sent|used up|not configured/.test(w)) || out.delivery };
  }
  async function finishInvite(tenantId, inv, visitId, actor, details, action) {
    await store.tenant(tenantId).unit()
      .raw("UPDATE visit_invites SET status = 'used', visit_id = ?, token_hash = NULL, submitted_name = ?, submitted_company = ?, submitted_start = ?, submitted_at = COALESCE(submitted_at, ?), decided_by = ? WHERE tenant_id = ? AND id = ?",
        [visitId, details.name, details.company || null, details.startLocal || null, new Date().toISOString(), action === 'invite.approved' ? actor : null, tenantId, inv.id])
      .audit(action, `${inv.id} visit ${visitId}`, actor).commit();
  }

  route('GET', /^\/api\/visit-invites$/, async ctx => {
    const snap = await ctx.snap();
    const rows = await store.sql.all('SELECT * FROM visit_invites WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200', [ctx.tenantId]);
    return { invites: rows.map(visitors.rowToInvite).filter(v => visitVisible(ctx, v)).map(v => inviteView(snap, v)), available: { links: Boolean(publicUrl), email: emailAvailable(), sms: smsAvailable() } };
  });

  route('POST', /^\/api\/visit-invites$/, async ctx => {
    if (!publicUrl) throw new HttpError(400, 'invitations need PUBLIC_URL (the link the visitor opens)');
    const body = ctx.body || {};
    const c = visitors.inviteContact(body);
    if (!c.ok) throw new HttpError(c.status, c.error);
    if (c.channel === 'email' && !emailAvailable()) throw new HttpError(400, 'email is not configured on this server: invite by mobile number');
    if (c.channel === 'sms' && !smsAvailable()) throw new HttpError(400, 'SMS is not configured on this server: invite by email');
    const snap = await ctx.snap();
    const lockIds = Array.isArray(body.lockIds) ? [...new Set(body.lockIds.map(Number))] : [];
    for (const id of lockIds.slice(0, visitors.LIMITS.maxDoors)) if (Number.isFinite(id)) await ctx.requireLock(id);
    if (!body.startLocal) throw new HttpError(400, 'startLocal is required for an invitation (time at the door)');
    // Same checks as a visit, now (and again when the visitor registers).
    const plan = visitors.planVisit(snap, { ...body, visitorName: 'invited visitor', visitorEmail: undefined, visitorPhone: undefined },
      { sensitive: sensitiveLockSet(snap), canSeeLock: id => ctx.scope.lock(id), canSeeUser: u => ctx.scope.userVisible(u) });
    if (!plan.ok) { const { ok: _ok, status, error, ...rest } = plan; throw new HttpError(status, error, rest); }
    const v = plan.visit;
    const sensitiveSite = siteIsSensitive(snap, v.siteId);
    let requireApproval = body.requireApproval === undefined ? sensitiveSite : body.requireApproval === true;
    if (!requireApproval && sensitiveSite && !(ctx.operator && ctx.operator.role === 'r_owner')) {
      throw new HttpError(403, 'this site has sensitive doors: registrations wait for reception to approve them (only an owner can switch that off)');
    }
    const open = await store.sql.first("SELECT COUNT(*) AS n FROM visit_invites WHERE tenant_id = ? AND status IN ('open', 'submitted') AND expires_at > ?", [ctx.tenantId, new Date().toISOString()]);
    if (Number(open.n) >= visitors.INVITE.maxOpen) throw new HttpError(429, `at most ${visitors.INVITE.maxOpen} open invitations: revoke unused ones first`);
    const id = policy.uid('inv');
    const token = randomB64url(18);
    const now = new Date().toISOString();
    await ctx.t.unit().raw(
      'INSERT INTO visit_invites (tenant_id, id, token_hash, host_user_id, site_id, lock_ids, start_local, end_local, start_at, end_at, channel, contact, require_approval, status, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ctx.tenantId, id, inviteHash(token), v.hostUserId, v.siteId, JSON.stringify(v.lockIds), String(body.startLocal), String(body.endLocal), v.startAt, v.endAt, c.channel, c.contact, requireApproval ? 1 : 0, 'open', ctx.actor, now, v.endAt])
      // No personal data in the audit chain (the address stays in the invite row, erasable).
      .audit('invite.create', `${id} host ${v.hostUserId} locks ${v.lockIds.join(',')} ${v.startAt}..${v.endAt} via ${c.channel} approval=${requireApproval ? 'yes' : 'no'}`, ctx.actor).commit();
    const inviteUrl = `${publicUrl.replace(/\/+$/, '')}/invite#${token}`;
    const tz = plan.timeZone;
    const label = iso => policy.localParts(new Date(iso), tz).label.replace(/ \S+$/, '');
    const site = snap.sites.find(x => x.id === v.siteId);
    const msg = visitors.inviteMessage({ channel: c.channel, hostName: plan.host.name || 'Your host', siteName: site ? site.name : null, url: inviteUrl, from: label(v.startAt), until: label(v.endAt), tenantName: snap.tenant && snap.tenant.name });
    const delivery = c.channel === 'email' ? await alerts.emailTo(c.contact, msg, `invite-${id}`) : await sendSms(ctx.tenantId, c.contact, msg);
    const warnings = [...plan.warnings];
    if (delivery !== 'delivered') warnings.push(`the invitation could not be sent (${delivery}): send the link yourself`);
    const row = await store.sql.first('SELECT * FROM visit_invites WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    // The link is shown once, to the operator who made it (the code still goes only to the fixed address).
    return { invite: inviteView(snap, visitors.rowToInvite(row)), inviteUrl, delivery, warnings };
  });

  route('POST', /^\/api\/visit-invites\/([^/]+)\/(revoke|approve|reject)$/, async (ctx, [id, verb]) => {
    const inv = await loadInvite(ctx, id);
    const state = inviteState(inv);
    if (verb === 'revoke') {
      if (!['open', 'submitted'].includes(state)) throw new HttpError(409, `invitation is ${state}`);
      await ctx.t.unit().raw("UPDATE visit_invites SET status = 'revoked', token_hash = NULL, decided_by = ? WHERE tenant_id = ? AND id = ?", [ctx.actor, ctx.tenantId, id])
        .audit('invite.revoke', id, ctx.actor).commit();
      return { invite: inviteView(await ctx.snap(), { ...inv, status: 'revoked', decidedBy: ctx.actor }) };
    }
    if (state !== 'submitted') throw new HttpError(409, `invitation is ${state}, not waiting for approval`);
    if (verb === 'reject') {
      await ctx.t.unit().raw("UPDATE visit_invites SET status = 'rejected', token_hash = NULL, decided_by = ? WHERE tenant_id = ? AND id = ?", [ctx.actor, ctx.tenantId, id])
        .audit('invite.rejected', id, ctx.actor).commit();
      return { invite: inviteView(await ctx.snap(), { ...inv, status: 'rejected', decidedBy: ctx.actor }) };
    }
    const details = { name: inv.submittedName, company: inv.submittedCompany, startLocal: inv.submittedStart };
    const r = await visitFromInvite(ctx, inv, details);
    if (!r.ok) throw new HttpError(502, `the code could not be delivered (${r.reason}); the visit was cancelled again`);
    await finishInvite(ctx.tenantId, inv, r.out.visit.id, ctx.actor, details, 'invite.approved');
    return { invite: inviteView(await ctx.snap(), { ...inv, status: 'used', visitId: r.out.visit.id, decidedBy: ctx.actor }), visit: r.out.visit, delivery: r.out.delivery };
  });

  async function inviteByToken(token) {
    if (!validToken(token)) return null;
    const row = await store.sql.first("SELECT * FROM visit_invites WHERE token_hash = ? AND status = 'open' AND expires_at > ?", [inviteHash(token), new Date().toISOString()]);
    if (!row || row.attempts >= visitors.INVITE.maxAttempts) return null;
    return row;
  }

  /** Inside the tenant's queue: the visitor's registration. */
  async function inviteSubmit(tenantId, job) {
    const row = await inviteByToken(job.token);
    if (!row || row.tenant_id !== tenantId) return { ok: false, gone: true };
    const inv = visitors.rowToInvite(row);
    await store.sql.batch([{ sql: 'UPDATE visit_invites SET attempts = attempts + 1 WHERE tenant_id = ? AND id = ?', params: [tenantId, inv.id] }]);
    const details = { name: String(job.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100), company: String(job.company || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) || null, startLocal: null };
    if (!details.name) return { ok: false, error: 'Please enter your name.' };
    if (job.startLocal) {
      const s = String(job.startLocal);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) || s < inv.startLocal || s >= inv.endLocal) return { ok: false, error: 'Please choose an arrival time inside the invitation.' };
      details.startLocal = s;
    }
    const t = store.tenant(tenantId);
    if (inv.requireApproval) {
      await t.unit().raw("UPDATE visit_invites SET status = 'submitted', submitted_name = ?, submitted_company = ?, submitted_start = ?, submitted_at = ? WHERE tenant_id = ? AND id = ? AND status = 'open'",
        [details.name, details.company, details.startLocal, new Date().toISOString(), tenantId, inv.id])
        .audit('invite.submitted', inv.id, 'visitor').commit();
      if (alerts) {
        await alerts.send(tenantId, 'approval_requested', {
          title: 'Visitor registration waiting', text: 'A visitor registered through an invitation to a site with sensitive doors. Approve or reject it under Visitors → Invitations.',
          facts: [['Invitation', inv.id]], path: '/#visitors',
        });
      }
      return { ok: true, pending: true, sentTo: visitors.maskContact(inv.channel, inv.contact) };
    }
    // Act as the operator who invited, with their CURRENT rights (they may have lost them since).
    const operator = await auth.operatorFor(tenantId, inv.createdBy);
    const snap = await t.snapshot();
    const refuse = async reason => {
      await t.unit().audit('invite.failed', `${inv.id}: ${String(reason).slice(0, 160)}`, 'visitor').commit();
      return { ok: false, error: 'This invitation can no longer be used. Please contact your host.' };
    };
    if (!operator || !rbac.hasPermission(snap, operator, 'visitor.manage')) return refuse('the inviting operator no longer manages visitors');
    const ctx = buildCtx({ t, vendor: await resolveVendor(tenantId), tenantId, operator, body: {}, query: new URLSearchParams(), method: 'POST', path: '/api/visits' });
    ctx.scope = scopeFor(snap, operator);
    ctx.actor = `invite:${inv.id}`;
    let r;
    try { r = await visitFromInvite(ctx, inv, details); } catch (error) { return refuse(error.message || error); }
    if (!r.ok) {
      await t.unit().audit('invite.failed', `${inv.id}: code not delivered (${String(r.reason).slice(0, 120)}), visit cancelled`, 'visitor').commit();
      return { ok: false, error: 'We could not send your code. Please try again later or contact your host.' };
    }
    await finishInvite(tenantId, inv, r.out.visit.id, ctx.actor, details, 'invite.used');
    return { ok: true, sentTo: visitors.maskContact(inv.channel, inv.contact) };
  }

  /** POST /api/visit-invite {token, action: 'status' | 'submit', name, company, startLocal} — no login. */
  async function visitInvitePublic(body, { dispatch = null } = {}) {
    await whenReady();
    const row = await inviteByToken(body && body.token);
    if (!row) return inviteGone;
    const tenantId = row.tenant_id;
    const inv = visitors.rowToInvite(row);
    if (body.action === 'submit') {
      const job = { type: 'invite_submit', token: body.token, name: body.name, company: body.company, startLocal: body.startLocal };
      const r = dispatch ? await dispatch(tenantId, job) : await serialize(tenantId, () => runTenantJob(tenantId, job));
      if (r && r.gone) return inviteGone;
      return { status: r && r.ok ? 200 : 400, body: r && r.ok ? { ok: true, pending: Boolean(r.pending), sentTo: r.sentTo } : { ok: false, error: (r && r.error) || 'Registration failed.' } };
    }
    const snap = await store.tenant(tenantId).snapshot();
    const site = snap.sites.find(x => x.id === inv.siteId);
    const host = snap.users.find(u => u.id === inv.hostUserId);
    const locks = await (await resolveVendor(tenantId)).listLocks().catch(() => []);
    return { status: 200, body: {
      ok: true, site: site ? site.name : null, host: host ? String(host.name || '').split(' ')[0] : null,
      doors: inv.lockIds.map(l => doorName(locks, l)), timeZone: policy.siteTimeZone(snap, inv.siteId),
      startLocal: inv.startLocal, endLocal: inv.endLocal, sendTo: visitors.maskContact(inv.channel, inv.contact), requireApproval: inv.requireApproval,
    } };
  }

  // Right to erasure: the visit (who/when/which doors, by id) stays; the person's details go.
  route('POST', /^\/api\/visits\/([^/]+)\/erase$/, async (ctx, [id]) => {
    const v = await loadVisit(ctx, id);
    if (v.erased) return { visit: visitView(await ctx.snap(), v) };
    const at = new Date().toISOString();
    await ctx.t.unit().raw('UPDATE visits SET visitor_name = NULL, visitor_email = NULL, visitor_phone = NULL, company = NULL, checkout_token_hash = NULL, erased_at = ? WHERE tenant_id = ? AND id = ?', [at, ctx.tenantId, id])
      .audit('visit.erased', `${id} (on request)`, ctx.actor).commit();
    if (alerts) await alerts.forget(ctx.tenantId, id);
    await store.sql.batch([{ sql: 'UPDATE visit_invites SET contact = NULL, submitted_name = NULL, submitted_company = NULL, erased_at = ? WHERE tenant_id = ? AND visit_id = ?', params: [at, ctx.tenantId, id] }]);
    return { visit: visitView(await ctx.snap(), { ...v, visitorName: null, visitorEmail: null, visitorPhone: null, company: null, erased: true, erasedAt: at }) };
  });

  // --- visitor arrival --------------------------------------------------
  // TTLock reports unlocks (callback or record list) with the code that was
  // typed. The first successful unlock with a visitor's code is their arrival.
  // Informational only: nothing here changes who can open what.

  /** Read-only, across tenants (the callback does not know the tenant). */
  async function matchArrivals(records, { tenantId = null } = {}) {
    if (!secretsKey) return [];
    const found = new Map();
    for (const r of visitors.arrivalCandidates(records)) {
      const at = new Date(r.at).toISOString();
      const rows = await store.sql.all(
        `SELECT tenant_id, id, code_macs FROM visits WHERE status = 'scheduled' AND arrived_at IS NULL AND code_macs IS NOT NULL AND start_at <= ? AND end_at >= ?${tenantId ? ' AND tenant_id = ?' : ''} AND EXISTS (SELECT 1 FROM json_each(visits.lock_ids) WHERE json_each.value = ?) LIMIT 50`,
        tenantId ? [at, at, tenantId, r.lockId] : [at, at, r.lockId]);
      for (const row of rows) {
        let stored = null;
        try { stored = JSON.parse(row.code_macs)[String(r.lockId)] || null; } catch { /* malformed: skip */ }
        if (!stored) continue;
        // The fingerprint binds tenant + lock + code: only the visitor's real code matches.
        if (!(await codeMacs(secretsKey, { tenantId: row.tenant_id, lockId: r.lockId, code: r.code }).catch(() => [])).includes(stored)) continue;
        const key = `${row.tenant_id}|${row.id}`;
        if (!found.has(key) || found.get(key).at > at) found.set(key, { tenantId: row.tenant_id, visitId: row.id, lockId: r.lockId, at });
      }
    }
    return [...found.values()];
  }

  /** Inside the tenant's write queue: record the first arrival once, then tell the host. */
  async function recordArrival(tenantId, m) {
    const row = await store.sql.first('SELECT * FROM visits WHERE tenant_id = ? AND id = ?', [tenantId, String(m.visitId)]);
    const at = new Date(m.at).toISOString();
    const lockId = Number(m.lockId);
    if (!row || row.arrived_at || row.status !== 'scheduled' || at < row.start_at || at > row.end_at) return { recorded: false };
    if (!JSON.parse(row.lock_ids || '[]').map(Number).includes(lockId)) return { recorded: false };
    await store.tenant(tenantId).unit()
      .raw('UPDATE visits SET arrived_at = ?, arrived_lock = ? WHERE tenant_id = ? AND id = ? AND arrived_at IS NULL', [at, lockId, tenantId, row.id])
      .audit('visit.arrived', `${row.id} lock ${lockId} at ${at} via ${m.source === 'records' ? 'records' : 'callback'}`, 'system').commit();
    const out = { recorded: true, visitId: row.id };
    const v = visitors.rowToVisit(row);
    const snap = await store.tenant(tenantId).snapshot();
    const host = snap.users.find(u => u.id === v.hostUserId);
    const locks = await (await resolveVendor(tenantId)).listLocks().catch(() => []);
    const door = doorName(locks, lockId);
    const tz = policy.siteTimeZone(snap, v.siteId);
    if (alerts && visitors.settingsOf(snap.settings).notifyHost && host && host.email && alerts.emailAvailable) {
      out.hostEmail = await alerts.emailTo(host.email, visitors.arrivalEmail({ visit: v, hostName: host.name, door, at, timeZone: tz, tenantName: snap.tenant && snap.tenant.name }), `arrival-${row.id}`);
    }
    if (alerts) {
      // Opt-in event (names a person): channels get it only if an owner enabled visitor_arrived.
      out.alert = await alerts.send(tenantId, 'visitor_arrived', {
        title: 'Visitor arrived',
        text: `${v.visitorName || 'A visitor'}${v.company ? ` (${v.company})` : ''} for ${host ? host.name : v.hostUserId} opened ${door}.`,
        facts: [['Door', door], ['Time', policy.localParts(new Date(at), tz).label], ['Visit', row.id]], path: '/#visitors',
        ref: row.id, // erasing the visitor deletes this message if it is still waiting (retry / daily summary)
      });
    }
    return out;
  }

  // --- lock alarms ----------------------------------------------------------
  /** Tenants whose door groups contain the lock (read-only; ownership is re-checked in the queue). */
  async function tenantsForLock(lockId) {
    const rows = await store.sql.all('SELECT DISTINCT tenant_id FROM door_groups WHERE EXISTS (SELECT 1 FROM json_each(door_groups.lock_ids) WHERE json_each.value = ?) LIMIT 20', [Number(lockId)]);
    return rows.map(r => r.tenant_id);
  }

  /**
   * Inside the tenant's write queue. The lock must be in the tenant's own TTLock
   * fleet (a door group may name any number): otherwise another customer's
   * alarm would leak. Stored once; announced at most once per lock and kind
   * per 30 min; audited when announced (no personal data).
   */
  async function recordAlarm(tenantId, a) {
    const type = lockEvents.KINDS[a.kind];
    const lockId = Number(a.lockId);
    const at = new Date(a.at).toISOString();
    if (!type || !Number.isSafeInteger(lockId) || Number.isNaN(Date.parse(at))) return { recorded: false };
    const locks = await (await resolveVendor(tenantId)).listLocks().catch(() => null);
    const lock = (locks || []).find(l => Number(l.lockId) === lockId);
    if (!lock) return { recorded: false, reason: 'not this tenant\'s lock' };
    if (await store.sql.first('SELECT 1 AS x FROM lock_alarms WHERE tenant_id = ? AND lock_id = ? AND kind = ? AND record_at = ?', [tenantId, lockId, a.kind, at])) return { recorded: false, reason: 'duplicate' };
    const recent = await store.sql.first('SELECT COUNT(*) AS n FROM lock_alarms WHERE tenant_id = ? AND lock_id = ? AND kind = ? AND alerted = 1 AND record_at > ? AND record_at <= ?',
      [tenantId, lockId, a.kind, new Date(Date.parse(at) - lockEvents.THROTTLE_MS).toISOString(), at]);
    const announce = !(recent && Number(recent.n));
    const received = new Date().toISOString();
    const late = Date.now() - Date.parse(at) > lockEvents.LATE_MS;
    const source = a.source === 'records' ? 'records' : 'callback';
    const u = store.tenant(tenantId).unit()
      .raw('INSERT INTO lock_alarms (tenant_id, lock_id, kind, record_at, received_at, source, alerted) VALUES (?, ?, ?, ?, ?, ?, ?)', [tenantId, lockId, a.kind, at, received, source, announce ? 1 : 0]);
    if (announce) u.audit('lock.alarm', `lock ${lockId} ${a.kind} at ${at} via ${source}${late ? ' (reported late)' : ''}`, 'system');
    await u.commit();
    const out = { recorded: true, announced: announce };
    if (announce && alerts) {
      const snap = await store.tenant(tenantId).snapshot();
      const site = policy.siteForLock(snap, lockId);
      const door = lock.lockAlias || String(lockId);
      const tz = site ? policy.siteTimeZone(snap, site.id) : 'UTC';
      out.alert = await alerts.send(tenantId, type.event, {
        title: `${door}: ${type.label}`,
        text: `${door}${site ? ` (${site.name})` : ''} reported: ${type.label}.${late ? ' Reported late: the lock has no gateway and uploaded its records when a phone synced.' : ''}${type.kind === 'keypad_locked' ? ' Someone entered several wrong codes.' : ''}`,
        facts: [['Door', `${door} (${lockId})`], ['Time', policy.localParts(new Date(at), tz).label], ['Alarm', type.kind]], path: '/#log',
      });
    }
    return out;
  }

  /** One write for a tenant, run in its queue (Node serialize / Worker Durable Object). */
  async function runTenantJob(tenantId, job) {
    await whenReady();
    if (job && job.type === 'alarm') return recordAlarm(tenantId, job);
    if (job && job.type === 'checkout') return visitorCheckout(tenantId, job);
    if (job && job.type === 'invite_submit') return inviteSubmit(tenantId, job);
    if (job && job.type === 'billing') return applyBillingEvent(tenantId, job);
    return recordArrival(tenantId, job);
  }

  /**
   * TTLock "lock records notify" callback: POST <form> to /api/ttlock/notify/<secret>
   * with records=<JSON array>. One callback URL per TTLock developer app, so it
   * serves every tenant; `dispatch(tenantId, match)` runs the write in that
   * tenant's queue (the Worker hops to its Durable Object).
   */
  async function ttlockNotify({ secret, form }, { dispatch = null } = {}) {
    if (!ttlockNotifySecret || !rbac.constantTimeEqual(String(secret || ''), ttlockNotifySecret)) return { status: 404, body: { ok: false, error: 'not found' } };
    await whenReady(); // may be the first request this instance serves (D1 migrations / seeding)
    const list = [];
    for (const chunk of [].concat((form && form.records) || [])) {
      try { list.push(...[].concat(typeof chunk === 'string' ? JSON.parse(chunk) : chunk)); } catch { /* not JSON: ignore */ }
    }
    const run = (tenantId, job) => (dispatch ? dispatch(tenantId, job) : serialize(tenantId, () => runTenantJob(tenantId, job)));
    const matches = await matchArrivals(list);
    let recorded = 0;
    for (const m of matches) {
      try {
        const r = await run(m.tenantId, { ...m, type: 'arrival' });
        if (r && r.recorded) recorded++;
      } catch (error) {
        log('visitor arrival failed', m.tenantId, error);
      }
    }
    let alarms = 0;
    const seen = new Set();
    for (const a of lockEvents.alarmCandidates(list)) {
      for (const tenantId of await tenantsForLock(a.lockId)) {
        try {
          const r = await run(tenantId, { ...a, type: 'alarm', source: 'callback' });
          if (r && r.recorded) alarms++;
        } catch (error) {
          log('lock alarm failed', tenantId, error);
        }
      }
    }
    // Pilot diagnostics: when did this tenant last hear from TTLock? (No audit: not a change.)
    for (const lockId of new Set(list.map(r => Number(r && r.lockId)).filter(Number.isSafeInteger))) {
      for (const tenantId of await tenantsForLock(lockId)) {
        if (seen.has(tenantId)) continue;
        seen.add(tenantId);
        await store.sql.batch([{ sql: "UPDATE tenants SET settings = json_set(COALESCE(settings, '{}'), '$.ttlockCallbackAt', ?) WHERE id = ? AND COALESCE(json_extract(settings, '$.ttlockCallbackAt'), '') < ?",
          params: [new Date().toISOString(), tenantId, new Date(Date.now() - 60e3).toISOString()] }]).catch(() => {});
      }
    }
    // Battery readings ride along on callback records (the lock's level at that moment;
    // the lowest reading of the day is kept: a battery only drains, a list value can be stale).
    const levels = new Map();
    for (const r of list) {
      const lvl = health.level(r && r.electricQuantity);
      const id = Number(r && r.lockId);
      if (lvl !== null && Number.isSafeInteger(id)) levels.set(id, lvl);
    }
    for (const [lockId, lvl] of levels) {
      for (const tenantId of await tenantsForLock(lockId)) await recordBatteries(tenantId, [{ lockId, level: lvl }]).catch(error => log('battery reading failed', tenantId, error));
    }
    return { status: 200, body: { ok: true, records: list.length, matched: matches.length, recorded, alarms } };
  }

  // --- lock health: battery trends, a silent TTLock callback (lock-health-core.js) ------
  async function recordBatteries(tenantId, readings, day = health.dayOf(Date.now())) {
    const ok = readings.map(r => ({ lockId: Number(r.lockId), level: health.level(r.level) })).filter(r => Number.isSafeInteger(r.lockId) && r.level !== null);
    if (!ok.length) return 0;
    await store.sql.batch(ok.map(r => ({ sql: 'INSERT INTO lock_battery (tenant_id, lock_id, day, level) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, lock_id, day) DO UPDATE SET level = MIN(level, excluded.level)', params: [tenantId, r.lockId, day, r.level] })));
    return ok.length;
  }
  // Operational markers in tenants.settings (not configuration: no audit).
  const setMarker = (tenantId, key, value) => store.sql.batch([{ sql: `UPDATE tenants SET settings = json_set(COALESCE(settings, '{}'), '$.${key}', ?) WHERE id = ?`, params: [value, tenantId] }]);
  const BATTERY_EVERY_MS = 6 * 36e5;
  async function batteryForecasts(tenantId, locks, now = Date.now()) {
    const rows = await store.sql.all('SELECT lock_id, day, level FROM lock_battery WHERE tenant_id = ? AND day >= ? ORDER BY day', [tenantId, health.dayOf(now - 90 * 864e5)]);
    const byLock = new Map();
    for (const r of rows) { const id = Number(r.lock_id); if (!byLock.has(id)) byLock.set(id, []); byLock.get(id).push({ day: r.day, level: Number(r.level) }); }
    return new Map(locks.map(l => [Number(l.lockId), health.forecast(byLock.get(Number(l.lockId)) || [], now)]));
  }
  const batteryLine = (l, f) => `${l.lockAlias || l.lockId} — ${f.level}%${f.daysLeft !== null ? `, about ${f.daysLeft} day${f.daysLeft === 1 ? '' : 's'} left${f.slopePerDay !== null ? ` (${-f.slopePerDay}%/day)` : ''}` : ''}${l.hasGateway ? '' : ' · no gateway: level as of the last app sync'}`;

  async function checkBatteries(tenantId, locks, now = Date.now()) {
    await recordBatteries(tenantId, locks.map(l => ({ lockId: l.lockId, level: l.electricQuantity })), health.dayOf(now));
    await store.sql.batch([{ sql: 'DELETE FROM lock_battery WHERE tenant_id = ? AND day < ?', params: [tenantId, health.dayOf(now - health.KEEP_DAYS * 864e5)] }]);
    const forecasts = await batteryForecasts(tenantId, locks, now);
    const prev = new Map((await store.sql.all('SELECT * FROM lock_health WHERE tenant_id = ?', [tenantId]))
      .map(r => [Number(r.lock_id), { band: r.battery_band, alertedAt: r.battery_alerted_at, replacedOn: r.replaced_on }]));
    const due = [];
    const writes = [];
    const upsert = (lockId, band, alertedAt, replacedOn) => writes.push({
      sql: 'INSERT INTO lock_health (tenant_id, lock_id, battery_band, battery_alerted_at, replaced_on) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, lock_id) DO UPDATE SET battery_band = excluded.battery_band, battery_alerted_at = excluded.battery_alerted_at, replaced_on = excluded.replaced_on',
      params: [tenantId, lockId, band, alertedAt, replacedOn],
    });
    for (const l of locks) {
      const id = Number(l.lockId);
      const f = forecasts.get(id);
      const p = prev.get(id) || null;
      const d = health.batteryDecision(p, f, now);
      if (d.alert) { due.push({ l, f }); upsert(id, f.band, new Date(now).toISOString(), f.replacedOn || (p && p.replacedOn) || null); }
      // A new battery (or a reading back above the bands): announce again next time it runs low.
      else if (d.state === 'replaced' || d.state === 'reset') upsert(id, 'ok', null, f.replacedOn || (p && p.replacedOn) || null);
    }
    if (writes.length) await store.sql.batch(writes);
    if (due.length && alerts) {
      const worst = due.some(x => x.f.band === 'critical') ? 'critical' : due.some(x => x.f.band === 'low') ? 'low' : 'forecast';
      due.sort((a, b) => a.f.level - b.f.level);
      await alerts.send(tenantId, 'battery_low', {
        title: due.length === 1 ? `Lock battery: ${due[0].l.lockAlias || due[0].l.lockId} at ${due[0].f.level}%` : `${due.length} locks need new batteries`,
        text: `${worst === 'critical' ? 'Replace now — a flat lock only opens with the emergency power contact or a mechanical key.' : worst === 'low' ? 'Plan a battery visit this week.' : 'At the current rate these reach 10% within three weeks.'}\n${due.map(x => `· ${batteryLine(x.l, x.f)}`).join('\n')}`,
        facts: due.slice(0, 10).map(x => [x.l.lockAlias || String(x.l.lockId), `${x.f.level}%${x.f.emptyOn ? ` · ~${x.f.emptyOn}` : ''}`]),
        path: '/#doors',
      });
    }
    return due.length;
  }

  /** TTLock's callback went quiet: are there records in the cloud it never sent us? */
  async function checkCallback(tenantId, locks, settings, now = Date.now()) {
    const gateway = locks.filter(l => l.hasGateway);
    const snap = await store.tenant(tenantId).snapshot();
    const timeZone = snap.sites.length ? policy.siteTimeZone(snap, snap.sites[0].id) : 'UTC';
    const lastAt = settings.ttlockCallbackAt;
    if (!health.callbackNeedsCheck({ lastAt, alertedFor: settings.callbackSilentFor, checkedAt: settings.callbackCheckedAt, gatewayDoors: gateway.length, timeZone }, now)) return null;
    await setMarker(tenantId, 'callbackCheckedAt', new Date(now).toISOString());
    const vendor = await resolveVendor(tenantId);
    const missed = [];
    const doors = [];
    for (const l of gateway.slice(0, 5)) {
      const recs = health.missedRecords((await vendor.records(l.lockId)).map(r => ({ ...r, lockId: Number(l.lockId) })), lastAt);
      if (recs.length) { missed.push(...recs); doors.push(l.lockAlias || String(l.lockId)); }
    }
    if (!missed.length) return { callbackQuiet: true }; // the doors were simply idle (a holiday)
    await setMarker(tenantId, 'callbackSilentFor', lastAt);
    // Catch up on what the callback would have told us (alarms are flagged as late).
    for (const m of await matchArrivals(missed, { tenantId })) await recordArrival(tenantId, { ...m, source: 'records' }).catch(error => log('arrival backfill failed', tenantId, error));
    for (const a of lockEvents.alarmCandidates(missed)) await recordAlarm(tenantId, { ...a, source: 'records' }).catch(error => log('alarm backfill failed', tenantId, error));
    await store.tenant(tenantId).unit().audit('ttlock.callback_silent', `no TTLock callback since ${lastAt}; ${missed.length} record(s) on ${doors.length} door(s) were not delivered`, 'system').commit();
    if (alerts) {
      await alerts.send(tenantId, 'callback_silent', {
        title: 'TTLock stopped calling back',
        text: `TTLock has not called AccessX since ${lastAt}, but it holds ${missed.length} newer record(s) from ${doors.join(', ')}. Until this is fixed, lock alarms and visitor arrivals arrive only through the ~15-minute polling (visitors on site) or not at all. Check the callback URL in the TTLock developer console (one URL per app: another integration may have replaced it).`,
        facts: [['Last callback', lastAt], ['Records not delivered', String(missed.length)], ['Doors', doors.join(', ')]],
        path: '/#visitors',
      });
    }
    return { callbackSilent: missed.length };
  }

  async function checkLockHealth(tenantId, now = Date.now()) {
    const settings = (await store.tenantSettings(tenantId)) || {};
    const recent = (key, ms) => settings[key] && now - Date.parse(settings[key]) < ms;
    const batteryDue = !recent('batteryCheckedAt', BATTERY_EVERY_MS);
    const callbackMaybe = Boolean(ttlockNotifySecret && settings.ttlockCallbackAt && settings.callbackSilentFor !== settings.ttlockCallbackAt && !recent('callbackCheckedAt', 36e5));
    if (!batteryDue && !callbackMaybe) return null;
    const locks = await (await resolveVendor(tenantId)).listLocks();
    const out = {};
    if (batteryDue) {
      await setMarker(tenantId, 'batteryCheckedAt', new Date(now).toISOString());
      const n = await checkBatteries(tenantId, locks, now);
      if (n) out.batteryAlerts = n;
    }
    if (callbackMaybe) Object.assign(out, (await checkCallback(tenantId, locks, settings, now)) || {});
    return out;
  }

  route('GET', /^\/api\/doors\/health$/, async ctx => {
    const locks = (await ctx.vendor.listLocks()).filter(l => ctx.scope.lock(l.lockId));
    const forecasts = await batteryForecasts(ctx.tenantId, locks);
    const s = (await store.tenantSettings(ctx.tenantId)) || {};
    return {
      locks: locks.map(l => ({ lockId: l.lockId, lockAlias: l.lockAlias, hasGateway: Boolean(l.hasGateway), ...forecasts.get(Number(l.lockId)) })),
      callback: { configured: Boolean(ttlockNotifySecret), lastAt: s.ttlockCallbackAt || null, silent: Boolean(s.ttlockCallbackAt && s.callbackSilentFor === s.ttlockCallbackAt) },
    };
  });

  /** Fallback without the callback: read recent records of doors with a visitor on site now. */
  async function pollArrivals(tenantId) {
    if (!secretsKey) return 0;
    const now = new Date().toISOString();
    const rows = await store.sql.all("SELECT id, lock_ids, start_at FROM visits WHERE tenant_id = ? AND status = 'scheduled' AND arrived_at IS NULL AND code_macs IS NOT NULL AND start_at <= ? AND end_at >= ? ORDER BY start_at LIMIT 20", [tenantId, now, now]);
    if (!rows.length) return 0;
    const vendor = await resolveVendor(tenantId);
    // Records reach the cloud promptly only through a gateway.
    const gateway = new Set((await vendor.listLocks()).filter(l => l.hasGateway).map(l => Number(l.lockId)));
    const lockIds = [...new Set(rows.flatMap(r => JSON.parse(r.lock_ids || '[]').map(Number)))].filter(id => gateway.has(id)).slice(0, 10);
    const since = Math.min(...rows.map(r => Date.parse(r.start_at)));
    let recorded = 0;
    for (const lockId of lockIds) {
      const records = (await vendor.records(lockId)).map(r => ({ ...r, lockId })).filter(r => Number(r.lockDate || r.serverDate) >= since);
      for (const m of await matchArrivals(records, { tenantId })) {
        if ((await recordArrival(tenantId, { ...m, source: 'records' })).recorded) recorded++;
      }
      // The records are here anyway: alarms on these doors too (all doors need the callback).
      for (const a of lockEvents.alarmCandidates(records)) await recordAlarm(tenantId, { ...a, source: 'records' }).catch(error => log('lock alarm failed', tenantId, error));
    }
    return recorded;
  }

  route('GET', /^\/api\/credentials$/, async ctx => {
    const snap = await ctx.snap();
    const visible = snap.credentials.filter(c => ctx.scope.lock(c.lockId));
    const ids = new Set(visible.map(c => c.id));
    return { credentials: visible, review: creds.reviewCredentials(snap).filter(f => ids.has(f.id)) };
  });

  route('DELETE', /^\/api\/credentials\/([^/]+)$/, async (ctx, [id]) => {
    const snap = await ctx.snap();
    const cred = snap.credentials.find(c => c.id === id);
    if (!cred) throw new HttpError(404, 'not found');
    if (!ctx.scope.lock(cred.lockId)) throw forbiddenSite(cred.lockId);
    if (!['active', 'pending_removal'].includes(cred.status)) throw new HttpError(409, `credential is already ${cred.status}`);
    const lock = (await ctx.vendor.listLocks()).find(l => Number(l.lockId) === Number(cred.lockId));
    const reason = String((ctx.body && ctx.body.reason) || 'manual').slice(0, 200);
    const at = new Date().toISOString();
    const uow = ctx.t.unit();
    let status;
    if (lock && lock.hasGateway) {
      if (cred.type === 'passcode' && cred.vendorRef) await ctx.vendor.deletePasscode(cred.lockId, cred.vendorRef);
      status = 'revoked';
      uow.audit('credential.revoke', `${cred.id} lock ${cred.lockId} user ${cred.userId}`, ctx.actor);
    } else {
      // No gateway: the code stays on the lock until someone removes it there.
      status = 'pending_removal';
      uow.audit('credential.pending_removal', `${cred.id} lock ${cred.lockId} user ${cred.userId}: no gateway, on-site removal required`, ctx.actor);
    }
    await uow.update('credentials', cred.id, { status, revokedAt: at, revokedBy: ctx.actor, revokeReason: reason }).commit();
    return {
      credential: { ...cred, status, revokedAt: at, revokedBy: ctx.actor, revokeReason: reason },
      next: status === 'pending_removal' ? 'Remove the code at the lock, then POST /api/credentials/:id/confirm-removed' : undefined,
    };
  });

  route('POST', /^\/api\/credentials\/([^/]+)\/confirm-removed$/, async (ctx, [id]) => {
    const snap = await ctx.snap();
    const cred = snap.credentials.find(c => c.id === id);
    if (!cred) throw new HttpError(404, 'not found');
    if (!ctx.scope.lock(cred.lockId)) throw forbiddenSite(cred.lockId);
    if (cred.status !== 'pending_removal') throw new HttpError(409, `credential is ${cred.status}, not pending_removal`);
    await ctx.t.unit().update('credentials', id, { status: 'revoked' })
      .audit('credential.removed_on_site', `${id} lock ${cred.lockId} user ${cred.userId}`, ctx.actor).commit();
    return { credential: { ...cred, status: 'revoked' } };
  });

  route('POST', /^\/api\/reconcile$/, async ctx => {
    const out = await reconcileTenant(ctx.tenantId, {
      dryRun: ctx.body.dryRun === true, lockFilter: id => ctx.scope.lock(id), actor: ctx.actor,
    });
    return out;
  });

  // --- policy compiler ---------------------------------------------------
  route('GET', /^\/api\/compile$/, async ctx => {
    const snap = await ctx.snap();
    const fleet = await ctx.visibleLocks();
    // cyclic support is model-dependent; unknown ⇒ false (conservative)
    const locks = fleet.map(l => ({ lockId: l.lockId, name: l.lockAlias, hasGateway: Boolean(l.hasGateway), cyclic: l.cyclic === true }));
    const scoped = { ...snap, assignments: snap.assignments.filter(a => ctx.scope.doorGroup(a.doorGroupId)) };
    const visible = new Set(locks.map(l => Number(l.lockId)));
    return {
      ...compiler.compile(scoped, locks),
      drift: creds.reviewCredentials(snap).filter(f => visible.has(Number(f.lockId))),
      pendingRemoval: snap.credentials.filter(c => c.status === 'pending_removal' && visible.has(Number(c.lockId))),
      notices: reconciler.dstNotices(snap, fleet, { now: Date.now(), days: 14, lockFilter: id => visible.has(Number(id)) }),
    };
  });

  // --- records & audit -----------------------------------------------------
  route('GET', /^\/api\/records\/(\d+)$/, async (ctx, [lockId]) => {
    await ctx.snap();
    await ctx.requireLock(lockId);
    if (!ctx.scope.lock(lockId)) throw forbiddenSite(lockId);
    return { records: await ctx.vendor.records(lockId) };
  });

  route('GET', /^\/api\/audit$/, async ctx => {
    await ctx.snap();
    const q = ctx.query;
    // Site-scoped operators see their own actions only: the tenant-wide
    // trail reveals activity at sites they do not manage.
    const actor = ctx.scope.all ? (q.get('actor') || null) : ctx.operator.id;
    const log = await ctx.t.auditRecent({ limit: Number(q.get('limit')) || 100, before: Number(q.get('before')) || null, action: q.get('action') || null, actor });
    return { log, scopedToActor: !ctx.scope.all };
  });
  route('GET', /^\/api\/audit\/verify$/, async ctx => ({ verification: await ctx.t.auditVerify() }));

  // --- enforced single sign-on ---------------------------------------------
  const ssoSettings = async tenantId => ((await store.tenantSettings(tenantId)) || {}).sso || null;
  const verifiedDomains = cfg => Object.entries((cfg && cfg.domainVerification) || {}).filter(([, v]) => v && v.verifiedAt).map(([d]) => d);
  /**
   * With enforcement on, people must come through the identity provider
   * (so disabling them there cuts them off). Exempt: SCIM machine tokens,
   * break-glass operators, and bootstrap operators from the server config.
   */
  async function ssoRequiredFor(tenantId, operator, signIn) {
    if (!operator || operator.anonymous || operator.platform || signIn === 'sso') return null;
    if (operator.role === 'r_provisioner' || operator.breakGlass || operator.env) return null;
    const cfg = await ssoSettings(tenantId);
    if (!cfg || !cfg.enforced) return null;
    return { status: 403, body: { ok: false, error: 'single sign-on is required for this account — sign in with your company account', code: 'sso_required' } };
  }
  const breakGlassHolders = async (ctx) => [
    ...(await ctx.t.operators()).filter(o => !o.revokedAt && o.breakGlass && o.role === 'r_owner'),
    ...auth.envOperators(ctx.tenantId).filter(o => o.role === 'r_owner'),
  ];

  // --- operators (people who administer the system) --------------------------
  route('GET', /^\/api\/operators$/, async ctx => {
    await ctx.snap();
    const list = (await ctx.t.operators()).filter(o => ctx.scope.all || (o.siteIds || []).every(s => ctx.scope.site(s)) && (o.siteIds || []).length);
    return { operators: list, bootstrap: auth.envOperators(ctx.tenantId) };
  });

  route('POST', /^\/api\/operators$/, async ctx => {
    const snap = await ctx.snap();
    const b = ctx.body;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 100) throw new HttpError(400, 'name is required (max 100 characters)');
    const role = rbac.roleFor(snap, b.role);
    if (!role) throw new HttpError(400, 'role does not match an existing role');
    let siteIds = Array.isArray(b.siteIds) ? [...new Set(b.siteIds.map(String))] : [];
    if (siteIds.includes('*')) siteIds = [];
    for (const s of siteIds) if (!snap.sites.some(x => x.id === s)) throw new HttpError(400, `siteIds: unknown site ${s}`);
    // No privilege escalation: you can only hand out what you hold yourself.
    const mine = rbac.permsFor(snap, ctx.operator);
    const theirs = b.role === 'r_owner' ? ['*'] : role.perms || [];
    if (!mine.includes('*') && theirs.some(p => !mine.includes(p))) throw new HttpError(403, 'forbidden', { detail: 'cannot grant a role with permissions you do not hold' });
    if (!ctx.scope.all && (!siteIds.length || siteIds.some(s => !ctx.scope.site(s)))) throw outOfScope('new operator must be limited to your own sites');
    const viaSso = b.auth === 'sso';
    const email = typeof b.email === 'string' && b.email.trim() ? b.email.trim().toLowerCase() : null;
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'email is not a valid address');
    if (viaSso && !email) throw new HttpError(400, 'email is required for single sign-on operators');
    if (viaSso && !(await store.tenantSettings(ctx.tenantId) || {}).sso) throw new HttpError(409, 'configure single sign-on first');
    if (email && (await ctx.t.operators()).some(o => !o.revokedAt && o.email === email)) throw new HttpError(409, 'an operator with this email already exists');
    const breakGlass = b.breakGlass === true;
    if (breakGlass && (b.role !== 'r_owner' || viaSso)) throw new HttpError(400, 'a break-glass operator must be a token-based owner');
    // SSO operators get an unusable random token hash: they can only sign in
    // through the identity provider (and are cut off when IT disables them there).
    const token = viaSso ? null : `ax_${randomToken()}`;
    const op = { id: policy.uid('op'), name, role: b.role, siteIds, email, breakGlass, tokenSha256: sha256Hex(token || `unusable:${randomToken()}`), createdBy: ctx.actor };
    const stmt = operatorStatement(ctx.tenantId, op);
    await ctx.t.unit().raw(stmt.sql, stmt.params)
      .audit('operator.create', `${op.id} role=${op.role} sites=${siteIds.join(',') || '*'}${viaSso ? ' auth=sso' : ''}${breakGlass ? ' break_glass' : ''}`, ctx.actor).commit();
    const operator = { id: op.id, name, role: op.role, siteIds, email: email || undefined, auth: viaSso ? 'sso' : 'token', breakGlass };
    // Token shown once; only the hash is stored.
    return viaSso ? { operator, invited: true } : { operator, token };
  });

  route('DELETE', /^\/api\/operators\/([^/]+)$/, async (ctx, [id]) => {
    await ctx.snap();
    if (id === ctx.operator.id) throw new HttpError(409, 'you cannot revoke your own access');
    const target = (await ctx.t.operators()).find(o => o.id === id && !o.revokedAt);
    if (!target) throw new HttpError(404, 'not found');
    if (!ctx.scope.all && (!(target.siteIds || []).length || target.siteIds.some(s => !ctx.scope.site(s)))) throw outOfScope('operator is outside your sites');
    if (target.breakGlass && ((await ssoSettings(ctx.tenantId)) || {}).enforced && (await breakGlassHolders(ctx)).filter(o => o.id !== id).length === 0) {
      throw new HttpError(409, 'this is the last break-glass owner while single sign-on is enforced — create another one (or turn enforcement off) first');
    }
    const at = new Date().toISOString();
    await ctx.t.unit().raw('UPDATE operators SET revoked_at = ? WHERE tenant_id = ? AND id = ?', [at, ctx.tenantId, id])
      .raw('UPDATE sessions SET revoked_at = ? WHERE tenant_id = ? AND operator_id = ? AND revoked_at IS NULL', [at, ctx.tenantId, id])
      .audit('operator.revoke', id, ctx.actor).commit();
    return { revoked: id };
  });

  // --- single sign-on configuration (owner only) ----------------------------
  const SSO_PURPOSE = 'sso.clientSecret';
  const publicSso = (cfg, origin) => ({
    sso: cfg ? {
      issuer: cfg.issuer, clientId: cfg.clientId, domains: cfg.domains || [], trustUnverifiedEmail: Boolean(cfg.trustUnverifiedEmail), hasClientSecret: Boolean(cfg.clientSecretEnc), updatedAt: cfg.updatedAt,
      enforced: Boolean(cfg.enforced),
      domainStatus: (cfg.domains || []).map(d => {
        const v = (cfg.domainVerification || {})[d] || {};
        return { domain: d, verified: Boolean(v.verifiedAt), verifiedAt: v.verifiedAt || null, record: v.token ? { name: `_accessx.${d}`, type: 'TXT', value: `accessx-verification=${v.token}` } : null };
      }),
    } : null,
    redirectUri: origin ? `${origin}/api/auth/sso/callback` : null,
    secretsKeyConfigured: Boolean(secretsKey),
  });
  const saveSettings = (ctx, settings) => ctx.t.unit().raw('UPDATE tenants SET settings = ? WHERE id = ?', [JSON.stringify(settings), ctx.tenantId]);

  route('GET', /^\/api\/sso$/, async ctx => publicSso((await store.tenantSettings(ctx.tenantId) || {}).sso, ctx.origin));

  route('PUT', /^\/api\/sso$/, async ctx => {
    const b = ctx.body;
    const settings = (await store.tenantSettings(ctx.tenantId)) || {};
    const prev = settings.sso || null;
    let issuer;
    try { issuer = new URL(String(b.issuer || '')); } catch { throw new HttpError(400, 'issuer must be a URL'); }
    // Owner-supplied URL fetched by the server: https only (SSRF / downgrade).
    if (issuer.protocol !== 'https:' && !allowHttpIssuers) throw new HttpError(400, 'issuer must use https');
    if (issuer.username || issuer.password || issuer.search || issuer.hash) throw new HttpError(400, 'issuer must be a plain URL');
    const issuerStr = String(b.issuer).replace(/\/+$/, '');
    const clientId = typeof b.clientId === 'string' ? b.clientId.trim() : '';
    if (!clientId || clientId.length > 200) throw new HttpError(400, 'clientId is required');
    const domains = [...new Set((Array.isArray(b.domains) ? b.domains : []).map(d => String(d).trim().toLowerCase()).filter(Boolean))];
    for (const d of domains) if (!DOMAIN_RE.test(d)) throw new HttpError(400, `domains: "${d}" is not a domain`);
    // A domain someone else has PROVEN (DNS) is theirs. Unproven claims do
    // not block anyone: the first tenant to publish the TXT record wins.
    for (const other of await store.listTenants()) {
      if (other.id === ctx.tenantId) continue;
      const clash = verifiedDomains(((await store.tenantSettings(other.id)) || {}).sso).find(d => domains.includes(d));
      if (clash) throw new HttpError(409, `domain ${clash} is already verified by another account`);
    }
    const prevVerification = (prev && prev.domainVerification) || {};
    const domainVerification = Object.fromEntries(domains.map(d => [d, prevVerification[d] || { token: randomB64url(18), verifiedAt: null }]));
    try { await oidc.discover(issuerStr); } catch (e) { throw new HttpError(400, `issuer discovery failed: ${e.message}`); }
    let clientSecretEnc = null;
    let secretNote = 'none';
    if (typeof b.clientSecret === 'string' && b.clientSecret) {
      if (!secretsKey) throw new HttpError(400, 'SECRETS_KEY is not configured on the server; cannot store a client secret (use a public client with PKCE, or set SECRETS_KEY)');
      clientSecretEnc = await encryptSecret(secretsKey, b.clientSecret, { tenantId: ctx.tenantId, purpose: SSO_PURPOSE });
      secretNote = 'set';
    } else if (b.clientSecret === undefined && prev && prev.clientSecretEnc && prev.issuer === issuerStr && prev.clientId === clientId) {
      clientSecretEnc = prev.clientSecretEnc;
      secretNote = 'kept';
    }
    const sso = { issuer: issuerStr, clientId, domains, domainVerification, enforced: Boolean(prev && prev.enforced), trustUnverifiedEmail: b.trustUnverifiedEmail === true, clientSecretEnc, updatedAt: new Date().toISOString() };
    await saveSettings(ctx, { ...settings, sso })
      .audit('sso.configure', `issuer=${issuerStr} client=${clientId} domains=${domains.join(',') || '-'} secret=${secretNote}${sso.trustUnverifiedEmail ? ' trustUnverifiedEmail' : ''}`, ctx.actor).commit();
    return publicSso(sso, ctx.origin);
  });

  route('DELETE', /^\/api\/sso$/, async ctx => {
    const settings = (await store.tenantSettings(ctx.tenantId)) || {};
    if (!settings.sso) throw new HttpError(404, 'single sign-on is not configured');
    if (settings.sso.enforced) throw new HttpError(409, 'turn off single sign-on enforcement before removing single sign-on');
    const { sso, ...rest } = settings;
    await saveSettings(ctx, rest)
      .raw("UPDATE sessions SET revoked_at = ? WHERE tenant_id = ? AND via = 'sso' AND revoked_at IS NULL", [new Date().toISOString(), ctx.tenantId])
      .audit('sso.remove', sso.issuer, ctx.actor).commit();
    return publicSso(null, ctx.origin);
  });

  /** Prove domain ownership: TXT _accessx.<domain> = accessx-verification=<token>. */
  route('POST', /^\/api\/sso\/domains\/verify$/, async ctx => {
    const settings = (await store.tenantSettings(ctx.tenantId)) || {};
    const cfg = settings.sso;
    const domain = String(ctx.body.domain || '').trim().toLowerCase();
    if (!cfg || !(cfg.domains || []).includes(domain)) throw new HttpError(404, 'add the domain to the single sign-on settings first');
    const entry = (cfg.domainVerification || {})[domain];
    if (!entry || !entry.token) throw new HttpError(409, 'save the single sign-on settings again to get a verification record');
    if (entry.verifiedAt) return publicSso(cfg, ctx.origin);
    if (!dns) throw new HttpError(501, 'DNS verification is not available in this deployment');
    const name = `_accessx.${domain}`;
    const expected = `accessx-verification=${entry.token}`;
    let found;
    try { found = await dns.txt(name); } catch (e) { throw new HttpError(502, `could not look up ${name}: ${e.message}`); }
    if (!found.includes(expected)) {
      throw new HttpError(409, `TXT record not found yet — add ${name} TXT "${expected}" (DNS changes can take a while)`, { expected: { name, type: 'TXT', value: expected }, found: found.slice(0, 5) });
    }
    for (const other of await store.listTenants()) {
      if (other.id !== ctx.tenantId && verifiedDomains(((await store.tenantSettings(other.id)) || {}).sso).includes(domain)) {
        throw new HttpError(409, `domain ${domain} is already verified by another account`);
      }
    }
    const sso = { ...cfg, domainVerification: { ...cfg.domainVerification, [domain]: { ...entry, verifiedAt: new Date().toISOString() } } };
    await saveSettings(ctx, { ...settings, sso }).audit('sso.domain_verified', `${domain} (TXT ${name})`, ctx.actor).commit();
    return publicSso(sso, ctx.origin);
  });

  /**
   * Enforce single sign-on for people. Turning it on requires that the
   * owner doing it is signed in through SSO right now (it works) and that a
   * break-glass owner exists (a way back in when the IdP is down).
   */
  route('PUT', /^\/api\/sso\/enforcement$/, async ctx => {
    const settings = (await store.tenantSettings(ctx.tenantId)) || {};
    const cfg = settings.sso;
    if (!cfg) throw new HttpError(409, 'configure single sign-on first');
    const enforced = ctx.body.enforced === true;
    if (enforced === Boolean(cfg.enforced)) return publicSso(cfg, ctx.origin);
    let revoked = 0;
    const uow = saveSettings(ctx, { ...settings, sso: { ...cfg, enforced } });
    if (enforced) {
      if (ctx.signIn !== 'sso') throw new HttpError(409, 'sign in with single sign-on yourself before enforcing it (so you know it works)');
      if (!(await breakGlassHolders(ctx)).length) throw new HttpError(409, 'create a break-glass owner first (POST /api/operators with breakGlass:true) — the way back in if the identity provider is down');
      const exempt = (await ctx.t.operators()).filter(o => o.breakGlass || o.role === 'r_provisioner').map(o => o.id);
      const at = new Date().toISOString();
      const stale = await store.sql.first(`SELECT COUNT(*) AS n FROM sessions WHERE tenant_id = ? AND via = 'token' AND revoked_at IS NULL${exempt.length ? ` AND operator_id NOT IN (${exempt.map(() => '?').join(',')})` : ''}`, [ctx.tenantId, ...exempt]);
      revoked = Number(stale.n);
      uow.raw(`UPDATE sessions SET revoked_at = ? WHERE tenant_id = ? AND via = 'token' AND revoked_at IS NULL${exempt.length ? ` AND operator_id NOT IN (${exempt.map(() => '?').join(',')})` : ''}`, [at, ctx.tenantId, ...exempt]);
    }
    await uow.audit('sso.enforce', enforced ? `on (token sessions ended: ${revoked})` : 'off', ctx.actor).commit();
    return { ...publicSso({ ...cfg, enforced }, ctx.origin), tokenSessionsEnded: revoked };
  });

  // --- reports ------------------------------------------------------------
  async function revocationFor(ctx, days) {
    const now = Date.now();
    const since = now - days * 86400e3;
    // Walk back through the chain until the window (plus 1 day of lead-in
    // for triggers whose credential events fall inside it) is covered.
    const events = [];
    for (let before = null; ;) {
      const page = await ctx.t.auditRecent({ limit: 1000, before });
      events.push(...page);
      if (page.length < 1000 || Date.parse(page[page.length - 1].ts) < since - 86400e3) break;
      before = page[page.length - 1].seq;
    }
    const snap = await ctx.snap();
    const report = revocationReport(events, { credentials: snap.credentials, now, since, lockVisible: id => ctx.scope.lock(id) });
    if (!ctx.scope.all) delete report.triggers; // other sites' leavers are not yours to count
    return { windowDays: days, generatedAt: new Date(now).toISOString(), ...report };
  }
  route('GET', /^\/api\/reports\/revocation$/, async ctx => ({
    ...(await revocationFor(ctx, Math.min(Math.max(Number(ctx.query.get('days')) || 30, 1), 365))),
    slaHours: slaOf(await ctx.snap()),
  }));

  // --- alerts (Slack / Teams / JSON webhook) ---------------------------------
  const needAlerts = () => { if (!alerts) throw new HttpError(501, 'alerts are not available in this deployment'); return alerts; };
  route('GET', /^\/api\/alerts$/, async ctx => ({ alerts: await needAlerts().settings(ctx.tenantId) }));
  route('PUT', /^\/api\/alerts$/, async ctx => ({ alerts: await needAlerts().save(ctx.tenantId, ctx.body, ctx.actor) }));
  route('POST', /^\/api\/alerts\/test$/, async ctx => {
    const status = await needAlerts().send(ctx.tenantId, 'test', {
      title: 'AccessX test alert', text: `Sent by ${ctx.actor}. You will get approval requests, overdue on-site removals, failed revocations, break-glass sign-ins and TTLock reconnect warnings here.`,
      facts: [['Tenant', (await ctx.snap()).tenant.name]], path: '/',
    }, { force: true });
    return { delivery: status, alerts: await alerts.settings(ctx.tenantId) };
  });

  // --- audit anchoring, export, retention -----------------------------------
  const ops = () => {
    if (!auditOps) throw new HttpError(501, 'audit anchoring is not available in this deployment');
    return auditOps;
  };
  const allSitesOnly = (ctx, what) => { if (!ctx.scope.all) throw outOfScope(`${what} needs all-site scope`); };
  const publicAuditSettings = s => ({ retentionDays: s.retentionDays || null, anchorWebhookHost: s.anchorWebhook ? new URL(s.anchorWebhook).host : null, minRetentionDays: 365 });

  route('GET', /^\/api\/audit\/anchors$/, async ctx => {
    allSitesOnly(ctx, 'audit anchors');
    const [anchors, checkpoint, publicKey, settings] = await Promise.all([
      ctx.t.anchors({ limit: Number(ctx.query.get('limit')) || 30 }), ctx.t.auditCheckpoint(), ops().publicKey(), ops().auditSettings(ctx.tenantId)]);
    return { anchors, checkpoint, publicKey, settings: publicAuditSettings(settings) };
  });
  route('POST', /^\/api\/audit\/anchor$/, async ctx => ops().anchor(ctx.tenantId, { actor: ctx.actor, force: ctx.body.force === true }));
  route('GET', /^\/api\/audit\/export$/, async ctx => {
    allSitesOnly(ctx, 'exporting the audit trail');
    const q = ctx.query;
    const out = await ops().exportRange(ctx.tenantId, { fromSeq: Number(q.get('fromSeq')) || 0, toSeq: Number(q.get('toSeq')) || null, limit: Number(q.get('limit')) || 5000 });
    // Who took a copy of the log is itself on the record.
    await ctx.t.unit().audit('audit.export', out.range ? `seq ${out.range.fromSeq}..${out.range.toSeq} (${out.entries.length} entries)` : 'empty', ctx.actor).commit();
    return out;
  });
  route('GET', /^\/api\/audit\/settings$/, async ctx => ({ settings: publicAuditSettings(await ops().auditSettings(ctx.tenantId)) }));
  route('PUT', /^\/api\/audit\/settings$/, async ctx => ({ settings: publicAuditSettings(await ops().saveSettings(ctx.tenantId, ctx.body, ctx.actor)) }));
  route('POST', /^\/api\/audit\/purge$/, async ctx => ops().purge(ctx.tenantId, { actor: ctx.actor, acknowledgeExport: ctx.body.acknowledgeExport === true }));

  /**
   * Evidence pack for ISO 27001 / SOC 2 audits: one document per period
   * with access removal times, who administers what, identity setup and
   * the state of the audit chain. "Supports evidence for" — not a
   * compliance claim.
   */
  route('GET', /^\/api\/reports\/evidence$/, async ctx => {
    allSitesOnly(ctx, 'the evidence pack');
    const days = Math.min(Math.max(Number(ctx.query.get('days')) || 30, 1), 366);
    const now = Date.now();
    const since = new Date(now - days * 86400e3).toISOString();
    const snap = await ctx.snap();
    const [revocation, verification, operators, settings, vendorAccount, fleet] = await Promise.all([
      revocationFor(ctx, days), ctx.t.auditVerify(), ctx.t.operators(), store.tenantSettings(ctx.tenantId),
      vendorAccounts ? vendorAccounts.status(ctx.tenantId) : null, ctx.vendor.listLocks().catch(() => []),
    ]);
    const anchors = auditOps ? (await ctx.t.anchors({ limit: 1000 })).filter(a => a.createdAt >= since) : [];
    const roleName = id => (rbac.roleFor(snap, id) || {}).name || id;
    const siteName = id => (snap.sites.find(x => x.id === id) || {}).name || id;
    const live = operators.filter(o => !o.revokedAt);
    const ageDays = t => (t ? Math.floor((now - Date.parse(t)) / 86400e3) : null);
    const people = live.filter(o => o.role !== 'r_provisioner').map(o => {
      const flags = [];
      if (!o.lastLoginAt && ageDays(o.createdAt) > 14) flags.push('never signed in');
      if (o.lastLoginAt && ageDays(o.lastLoginAt) > 90) flags.push('no sign-in for 90+ days');
      if (o.breakGlass) flags.push('break-glass (token kept for emergencies)');
      else if (o.role === 'r_owner' && !o.ssoLinked) flags.push('owner without single sign-on');
      return { id: o.id, name: o.name, email: o.email || null, role: roleName(o.role), sites: (o.siteIds || []).length ? o.siteIds.map(siteName) : ['all'],
        signIn: o.ssoLinked ? 'sso' : o.email ? 'sso (invited)' : 'token', lastLoginAt: o.lastLoginAt || null, createdAt: o.createdAt, flags };
    });
    const pending = snap.credentials.filter(c => c.status === 'pending_removal').map(c => ({
      credentialId: c.id, lockId: c.lockId, userId: c.userId, since: c.revokedAt, ageHours: c.revokedAt ? Math.round((now - Date.parse(c.revokedAt)) / 36e5) : null }));
    const scimUsers = snap.users.filter(u => u.source === 'scim');
    const sso = (settings || {}).sso;
    const auditSettings = auditOps ? await auditOps.auditSettings(ctx.tenantId) : {};
    const apprRows = await store.sql.all('SELECT status, COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND requested_at >= ? GROUP BY status', [ctx.tenantId, since]);
    const fourEyesStats = Object.fromEntries(apprRows.map(r => [r.status, Number(r.n)]));
    const evidence = {
      period: { days, from: since, to: new Date(now).toISOString() },
      tenant: snap.tenant,
      generatedBy: ctx.actor,
      accessRemoval: {
        remote: revocation.remote, onSite: revocation.onsite, triggers: revocation.triggers ? revocation.triggers.length : undefined,
        stillOpen: revocation.open, pendingOnSite: pending, slaHours: slaOf(snap),
        overdueOnSite: pending.filter(p => p.ageHours >= slaOf(snap)).length,
      },
      administrators: { people, machineIdentities: live.filter(o => o.role === 'r_provisioner').map(o => ({ id: o.id, name: o.name, createdAt: o.createdAt })),
        bootstrap: auth.envOperators(ctx.tenantId).map(o => ({ id: o.id, name: o.name, role: roleName(o.role), note: 'server configuration (env token)' })),
        revokedInPeriod: operators.filter(o => o.revokedAt && o.revokedAt >= since).map(o => ({ id: o.id, name: o.name, revokedAt: o.revokedAt })) },
      identity: {
        singleSignOn: sso ? { issuer: sso.issuer, domains: sso.domains || [], verifiedDomains: verifiedDomains(sso), enforced: Boolean(sso.enforced) } : null,
        directorySync: { connections: live.filter(o => o.role === 'r_provisioner').length, people: scimUsers.length, deactivated: scimUsers.filter(u => u.directoryStatus === 'inactive').length,
          mappedGroups: snap.directoryGroups.filter(g => g.userGroupId).length, unmappedGroups: snap.directoryGroups.filter(g => !g.userGroupId).length },
      },
      doors: { total: fleet.length, withoutGateway: fleet.filter(l => !l.hasGateway).length, vendorAccount: vendorAccount && vendorAccount.connected ? { status: vendorAccount.status, lockCount: vendorAccount.lockCount } : null,
        clockChanges: reconciler.dstNotices(snap, fleet, { now, days: 30, lockFilter: () => true }) },
      fourEyes: {
        sensitiveDoorGroups: snap.doorGroups.filter(g => g.sensitive).map(g => ({ id: g.id, name: g.name, doors: (g.lockIds || []).length })),
        requestsInPeriod: fourEyesStats,
      },
      auditTrail: {
        verification, retentionDays: auditSettings.retentionDays || null, anchorWebhookHost: auditSettings.anchorWebhook ? new URL(auditSettings.anchorWebhook).host : null,
        anchors: { inPeriod: anchors.length, signed: anchors.filter(a => a.signature).length, deliveredOutside: anchors.filter(a => a.deliveryStatus === 'delivered').length, last: anchors[0] || null },
        publicKey: auditOps ? await auditOps.publicKey() : null,
      },
      controls: [
        { framework: 'ISO/IEC 27001:2022', control: 'A.7.2', title: 'Physical entry', evidence: ['doors', 'accessRemoval'] },
        { framework: 'ISO/IEC 27001:2022', control: 'A.5.18', title: 'Access rights (provision, review, removal)', evidence: ['accessRemoval', 'identity.directorySync', 'administrators'] },
        { framework: 'ISO/IEC 27001:2022', control: 'A.5.16', title: 'Identity management', evidence: ['identity'] },
        { framework: 'ISO/IEC 27001:2022', control: 'A.8.2', title: 'Privileged access rights', evidence: ['administrators'] },
        { framework: 'ISO/IEC 27001:2022', control: 'A.5.3', title: 'Segregation of duties', evidence: ['fourEyes'] },
        { framework: 'ISO/IEC 27001:2022', control: 'A.8.15', title: 'Logging', evidence: ['auditTrail'] },
        { framework: 'ISO/IEC 27001:2022', control: 'A.8.17', title: 'Clock synchronisation', evidence: ['doors.clockChanges'] },
        { framework: 'SOC 2 (TSC 2017)', control: 'CC6.4', title: 'Restricts physical access to facilities', evidence: ['doors', 'accessRemoval'] },
        { framework: 'SOC 2 (TSC 2017)', control: 'CC6.2', title: 'Registration and removal of users', evidence: ['identity.directorySync', 'accessRemoval'] },
        { framework: 'SOC 2 (TSC 2017)', control: 'CC6.3', title: 'Role-based access, removal on change', evidence: ['administrators', 'accessRemoval'] },
        { framework: 'SOC 2 (TSC 2017)', control: 'CC7.2', title: 'Monitoring of system components (logs)', evidence: ['auditTrail'] },
      ],
      disclaimer: 'Supports evidence for the listed controls; it is not a certification or a compliance claim.',
    };
    await ctx.t.unit().audit('report.evidence', `window=${days}d`, ctx.actor).commit();
    return { evidence };
  });

  // --- directory (SCIM) overview + group mapping ---------------------------
  route('GET', /^\/api\/directory$/, async ctx => {
    const snap = await ctx.snap();
    const scimUsers = snap.users.filter(u => u.source === 'scim');
    const provisioners = (await ctx.t.operators()).filter(o => o.role === 'r_provisioner' && !o.revokedAt).map(o => ({ id: o.id, name: o.name, createdAt: o.createdAt }));
    return {
      scimBaseUrl: `${ctx.origin}/scim/v2`,
      users: { total: scimUsers.length, inactive: scimUsers.filter(u => u.directoryStatus === 'inactive').length },
      groups: snap.directoryGroups.map(g => ({
        id: g.id, displayName: g.displayName, externalId: g.externalId, members: (g.memberIds || []).length,
        userGroupId: g.userGroupId || null, userGroupName: (snap.userGroups.find(x => x.id === g.userGroupId) || {}).name,
      })),
      // User groups that the directory currently controls (manual edits are overwritten).
      controlledUserGroups: [...new Set(snap.directoryGroups.map(g => g.userGroupId).filter(Boolean))],
      provisioners: ctx.scope.all ? provisioners : undefined,
    };
  });

  route('PUT', /^\/api\/directory\/groups\/([^/]+)$/, async (ctx, [id]) => {
    if (!ctx.scope.all) throw outOfScope('mapping directory groups needs all-site scope');
    const target = ctx.body.userGroupId === null || ctx.body.userGroupId === '' ? null : String(ctx.body.userGroupId || '');
    if (target === '') throw new HttpError(400, 'userGroupId is required (or null to unmap)');
    if (target) {
      const gate = await fourEyes(ctx, locksOfUserGroups(await ctx.snap(), [target]), `directory group ${id} -> user group ${target}`);
      if (gate) return gate;
    }
    const out = await ctx.t.transact((snap, uow) => {
      const g = snap.directoryGroups.find(x => x.id === id);
      if (!g) throw new HttpError(404, 'not found');
      if (target && !snap.userGroups.some(x => x.id === target)) throw new HttpError(400, 'userGroupId does not match a user group');
      if ((g.userGroupId || null) === target) return { changed: [] };
      uow.update('directoryGroups', id, { userGroupId: target }).audit('directory.group_mapped', `${id} -> ${target || '-'}`, ctx.actor);
      const after = { ...snap, directoryGroups: snap.directoryGroups.map(x => (x.id === id ? { ...x, userGroupId: target } : x)) };
      const changed = membershipChanges(after, g.userGroupId ? [g.userGroupId] : []);
      for (const c of changed) uow.update('users', c.userId, { groupIds: c.groupIds });
      return { changed };
    });
    const lost = out.changed.filter(c => c.lost.length).length;
    const reconcile = lost ? await reconcileAfter(ctx, {}) : undefined;
    return { mapped: { id, userGroupId: target }, usersChanged: out.changed.length, usersLostAccess: lost, reconcile };
  });

  // --- office setup pack (onboarding-core.js) ------------------------------------------
  /** Where an office stands on the way to "doors run themselves". */
  async function officeChecklist(ctx, snap, locks) {
    const s = (await store.tenantSettings(ctx.tenantId)) || {};
    const account = vendorAccounts ? await vendorAccounts.status(ctx.tenantId).catch(() => null) : null;
    const grouped = new Set(snap.doorGroups.flatMap(g => g.lockIds.map(Number)));
    const alertCfg = alerts ? await alerts.settings(ctx.tenantId).catch(() => null) : null;
    const item = (id, label, done, hint, link) => ({ id, label, done: Boolean(done), hint, link });
    return [
      item('ttlock', 'Connect your TTLock account', account && account.connected && account.status !== 'needs_reconnect', account && account.status === 'needs_reconnect' ? 'TTLock refused the saved login: reconnect it.' : 'People → Operators & sign-in → TTLock account. Until then you see the demo doors.', '#admin'),
      item('doors', 'Put every door in a door group', locks.length && locks.every(l => grouped.has(Number(l.lockId))), `${locks.filter(l => !grouped.has(Number(l.lockId))).length} of ${locks.length} door(s) not grouped yet — the office setup below does it.`, '#setup'),
      item('rules', 'Rules: who may open which doors when', snap.assignments.length > 0, 'The office setup creates Staff and Cleaners rules.', '#rules'),
      item('sensitive', 'Mark sensitive doors (changes need two people)', snap.doorGroups.some(g => g.sensitive), 'Server room, comms, safe…: the office setup marks them.', '#rules'),
      item('people', 'Add people', snap.users.length > 0, 'Best from your directory (SCIM, next step); or by hand under People.', '#people'),
      item('scim', 'Sync people from your directory (SCIM)', snap.users.some(u => u.source === 'scim'), 'Leavers then lose their codes when HR disables them in Entra ID / Okta / Google.', '#admin'),
      item('sso', 'Sign in with your company account (SSO)', s.sso && s.sso.issuer, 'People → Operators & sign-in → Single sign-on; then require it so shared tokens stop working.', '#admin'),
      item('alerts', 'Send alerts to Slack, Teams or email', alertCfg && alertCfg.configured, 'Tamper alarms, low batteries, failed revocations.', '#admin'),
      item('callback', 'TTLock callback URL (instant alarms and arrivals)', s.ttlockCallbackAt, ttlockNotifySecret ? 'Set the callback URL in the TTLock developer console; this ticks once TTLock calls.' : 'Set TTLOCK_NOTIFY_SECRET on the server, then the callback URL in the TTLock console.', '#visitors'),
      item('visitors', 'Visitor codes by email or text', emailAvailable() || smsAvailable(), 'Needs EMAIL_PROVIDER or SMS_PROVIDER on the server.', '#visitors'),
    ];
  }
  const officeOptions = (body, snap) => {
    const timeZone = body.timeZone || (snap.settings && snap.settings.defaultTimezone);
    if (!policy.isValidTimeZone(timeZone) || timeZone === 'UTC' && !body.timeZone) throw new HttpError(400, 'timeZone is required (the offices\' IANA time zone, e.g. "Europe/London")');
    const hours = (w, name) => {
      if (w === undefined) return undefined;
      try { return validate('schedules', { name, windows: [w] }, snap).windows[0]; } catch (error) { throw new HttpError(400, `${name}: ${error.message}`); }
    };
    return { timeZone, officeHours: hours(body.officeHours, 'officeHours'), cleaningHours: hours(body.cleaningHours, 'cleaningHours') };
  };

  route('GET', /^\/api\/onboarding\/office$/, async ctx => {
    const snap = await ctx.snap();
    const locks = await ctx.vendor.listLocks();
    const q = ctx.query;
    const tz = q.get('timeZone');
    const plan = tz && policy.isValidTimeZone(tz) ? onboarding.plan(locks, snap, officeOptions({ timeZone: tz }, snap)) : null;
    return { plan, checklist: await officeChecklist(ctx, snap, locks), defaults: onboarding.DEFAULTS };
  });

  route('POST', /^\/api\/onboarding\/office$/, async ctx => {
    const snap = await ctx.snap();
    const locks = await ctx.vendor.listLocks();
    // The plan is recomputed here: the client only chooses the time zone and hours.
    const plan = onboarding.plan(locks, snap, officeOptions(ctx.body || {}, snap));
    const sensitiveLocks = sensitiveLockSet(snap);
    const work = { ...snap, sites: [...snap.sites], doorGroups: [...snap.doorGroups], schedules: [...snap.schedules], userGroups: [...snap.userGroups], assignments: [...snap.assignments] };
    const ids = new Map();
    const created = { sites: 0, doorGroups: 0, schedules: 0, userGroups: 0, assignments: 0 };
    const uow = ctx.t.unit();
    const add = (coll, body, key) => {
      const clean = validate(coll, body, work);
      const item = { ...clean, id: policy.uid(coll.slice(0, 3)) };
      work[coll].push(item);
      uow.insert(coll, item).audit(`${coll}.create`, `${createDetail(coll, item)} (office setup)`, ctx.actor);
      ids.set(key, item.id);
      created[coll]++;
      return item;
    };
    for (const x of plan.sites) x.existingId ? ids.set(x.key, x.existingId) : add('sites', { name: x.name, timezone: x.timezone }, x.key);
    for (const x of plan.schedules) x.existingId ? ids.set(x.key, x.existingId) : add('schedules', { name: x.name, windows: x.windows, denyOnHolidays: x.denyOnHolidays }, x.key);
    for (const x of plan.doorGroups) {
      // Never widen access to a door that is already sensitive without the four-eyes path.
      if (!x.sensitive && x.lockIds.some(id => sensitiveLocks.has(id))) throw new HttpError(409, `${x.name} would contain a sensitive door: move it by hand (needs approval)`);
      add('doorGroups', { name: x.name, siteId: ids.get(x.siteKey), lockIds: x.lockIds, sensitive: x.sensitive }, x.key);
    }
    for (const x of plan.userGroups) x.existingId ? ids.set(x.key, x.existingId) : add('userGroups', { name: x.name, siteId: ids.get(x.siteKey) }, x.key);
    for (const a of plan.assignments) {
      const body = { userGroupId: ids.get(a.userGroupKey), doorGroupId: ids.get(a.doorGroupKey), scheduleId: ids.get(a.scheduleKey) };
      if (!work.assignments.some(x => x.userGroupId === body.userGroupId && x.doorGroupId === body.doorGroupId && x.scheduleId === body.scheduleId)) add('assignments', body, `${a.userGroupKey}>${a.doorGroupKey}`);
    }
    const total = Object.values(created).reduce((a, b) => a + b, 0);
    if (!total) return { created, plan, checklist: await officeChecklist(ctx, snap, locks), message: 'Nothing to do: every door is already in a door group.' };
    uow.audit('onboarding.office', `office setup: ${Object.entries(created).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')} (tz ${plan.timeZone})`, ctx.actor);
    await uow.commit();
    const after = await ctx.t.snapshot();
    return { created, plan, checklist: await officeChecklist(ctx, after, locks) };
  });

  // --- vendor / mirror / health ---------------------------------------------
  route('GET', /^\/api\/vendor$/, async ctx => ctx.vendor.info());

  // Per-tenant TTLock account (owner only: it controls every door).
  const accounts = () => {
    if (!vendorAccounts) throw new HttpError(501, 'vendor accounts are not available in this deployment');
    return vendorAccounts;
  };
  route('GET', /^\/api\/vendor-account$/, async ctx => ({ account: await accounts().status(ctx.tenantId) }));
  route('PUT', /^\/api\/vendor-account$/, async ctx => {
    const account = await accounts().connect(ctx.tenantId, ctx.body, ctx.actor);
    // Codes issued on the previous fleet: the reconciler decides what must come off.
    const reconcile = await reconcileAfter(ctx, {});
    return { account, reconcile };
  });
  route('DELETE', /^\/api\/vendor-account$/, async ctx => ({ account: await accounts().disconnect(ctx.tenantId, ctx.actor) }));
  const mirrorOf = ctx => {
    if (!ctx.vendor.mirror) throw new HttpError(501, 'record mirror is not available for this tenant yet');
    return ctx.vendor.mirror;
  };
  route('POST', /^\/api\/mirror\/sync$/, async ctx => mirrorOf(ctx).sync(ctx.body));
  route('GET', /^\/api\/mirror\/coverage$/, async ctx => mirrorOf(ctx).coverage());
  route('GET', /^\/api\/mirror\/records$/, async ctx => {
    const q = ctx.query;
    return {
      records: await mirrorOf(ctx).query({
        lockId: q.get('lockId') || null, from: q.get('from') ? Number(q.get('from')) : null,
        to: q.get('to') ? Number(q.get('to')) : null, limit: q.get('limit') ? Number(q.get('limit')) : 500,
      }),
    };
  });
  route('GET', /^\/api\/health$/, async ctx => {
    const doors = await ctx.visibleLocks();
    const low = doors.filter(d => d.electricQuantity <= 25);
    const offline = doors.filter(d => !d.hasGateway);
    return { total: doors.length, lowBattery: low, offline, score: Math.round(100 - (low.length * 12 + offline.length * 8)) };
  });

  route('POST', /^\/api\/ai$/, async ctx => ({ answer: await copilot(ctx) }));

  // --- platform: tenants ---------------------------------------------------
  route('GET', /^\/api\/tenants$/, async () => ({ tenants: await store.listTenants() }));
  route('POST', /^\/api\/tenants$/, async ctx => {
    const name = typeof ctx.body.name === 'string' ? ctx.body.name.trim() : '';
    if (!name || name.length > 100) throw new HttpError(400, 'name is required (max 100 characters)');
    const ownerName = String(ctx.body.ownerName || 'Account owner').slice(0, 100);
    const id = `t_${randomToken(6)}`;
    const t = await store.createTenant(id, name);
    await seedTenant(store, id, { data: {}, source: 'platform' });
    const token = `ax_${randomToken()}`;
    const op = { id: policy.uid('op'), name: ownerName, role: 'r_owner', tokenSha256: sha256Hex(token), createdBy: 'platform' };
    const stmt = operatorStatement(id, op);
    await t.unit().raw(stmt.sql, stmt.params).audit('operator.create', `${op.id} role=r_owner sites=*`, 'platform').commit();
    return { tenant: { id, name }, owner: { id: op.id, name: ownerName, token } };
  });

  // --- platform: SECRETS_KEY rotation ------------------------------------
  // Deployment-wide (all tenants), so platform-only. Prepend the new key to
  // SECRETS_KEY ("new,old"), deploy, POST reseal, drop the old key once GET
  // reports onOldKeys = 0.
  const rotation = () => {
    if (!secretsKey) throw new HttpError(503, 'SECRETS_KEY is not configured', { reason: 'secrets_key_missing' });
    return createSecretsRotation({ store, secretsKey });
  };
  route('GET', /^\/api\/platform\/secrets$/, async () => rotation().status());

  // --- platform: metered usage (billing) and per-tenant limits -------------
  // --- billing (Stripe; docs/BILLING.md) -------------------------------------
  const billingOn = () => Boolean(billing && billing.config && billing.config.active);
  async function billingAccount(tenantId) {
    const r = await store.sql.first('SELECT * FROM billing_accounts WHERE tenant_id = ?', [tenantId]);
    return r ? { customerId: r.stripe_customer_id, subscriptionId: r.stripe_subscription_id, status: r.status, pastDueSince: r.past_due_since, lastEventAt: Number(r.last_event_at) || 0, updatedAt: r.updated_at } : null;
  }
  /** 402 for additions while the subscription is unpaid past the grace period. Removals always pass. */
  async function billingBlock(tenantId, method, path) {
    if (!billingOn() || !billingCore.isAddition(method, path)) return null;
    const st = billingCore.standing(await billingAccount(tenantId));
    if (!st.restricted) return null;
    return { status: 402, body: { ok: false, reason: 'billing_restricted', billing: st,
      error: `The subscription is ${st.status === 'canceled' ? 'cancelled' : 'unpaid'}: adding people, visitors, codes or rules is paused until billing is sorted (owner: People → Billing). Removing access, exports and the audit still work, and existing codes keep opening doors.` } };
  }
  const billingBase = ctx => String(publicUrl || ctx.origin || '').replace(/\/+$/, '');
  const monthUsage = async (tenantId, p) => {
    const d = await store.sql.first("SELECT COALESCE(SUM(value), 0) AS n FROM billing_reports WHERE tenant_id = ? AND meter = 'door_days' AND report_key LIKE ?", [tenantId, `${p}-%`]);
    const s = await store.sql.first("SELECT n FROM usage_counters WHERE tenant_id = ? AND period = ? AND kind = 'sms_segments'", [tenantId, p]);
    return { doorDays: Number((d || {}).n || 0), smsSegments: Number((s || {}).n || 0) };
  };

  route('GET', /^\/api\/billing$/, async ctx => {
    if (!billingOn()) return { billing: { enabled: false } };
    const account = await billingAccount(ctx.tenantId);
    const p = period();
    const unsent = await store.sql.first('SELECT COUNT(*) AS n FROM billing_reports WHERE tenant_id = ? AND sent_at IS NULL', [ctx.tenantId]);
    return { billing: { enabled: true, testMode: billing.config.testMode, subscribed: Boolean(account && !['canceled', 'incomplete_expired'].includes(account.status)),
      standing: billingCore.standing(account), since: account ? account.updatedAt : null, period: p, usage: await monthUsage(ctx.tenantId, p), unsentReports: Number((unsent || {}).n || 0),
      smsBilled: Boolean(billing.config.priceSms) } };
  });

  route('POST', /^\/api\/billing\/checkout$/, async ctx => {
    if (!billingOn()) throw new HttpError(404, 'billing is not enabled on this deployment');
    const account = await billingAccount(ctx.tenantId);
    if (account && !['canceled', 'incomplete_expired'].includes(account.status)) throw new HttpError(409, 'already subscribed: use Manage billing to change the card or plan');
    const base = billingBase(ctx);
    if (!/^https?:\/\//.test(base)) throw new HttpError(503, 'PUBLIC_URL is needed to come back from Stripe Checkout');
    const c = billing.config;
    const params = {
      mode: 'subscription',
      line_items: [{ price: c.priceDoorDays }, ...(c.priceSms ? [{ price: c.priceSms }] : [])],
      client_reference_id: ctx.tenantId,
      metadata: { tenant_id: ctx.tenantId },
      subscription_data: { metadata: { tenant_id: ctx.tenantId } },
      success_url: `${base}/#billing-done`,
      cancel_url: `${base}/#billing`,
      tax_id_collection: { enabled: true },
      ...(c.automaticTax ? { automatic_tax: { enabled: true }, billing_address_collection: 'required' } : {}),
      ...(account ? { customer: account.customerId } : ctx.operator && ctx.operator.email ? { customer_email: ctx.operator.email } : {}),
    };
    // A double click inside the same minute returns the same session.
    const session = await billing.stripe.checkout(params, `checkout:${ctx.tenantId}:${Math.floor(Date.now() / 60e3)}`);
    await ctx.t.unit().audit('billing.checkout', `Stripe Checkout session ${String(session.id || '').slice(0, 40)}`, ctx.actor).commit();
    return { url: session.url };
  });

  route('POST', /^\/api\/billing\/portal$/, async ctx => {
    if (!billingOn()) throw new HttpError(404, 'billing is not enabled on this deployment');
    const account = await billingAccount(ctx.tenantId);
    if (!account) throw new HttpError(409, 'no subscription yet: start one first');
    const session = await billing.stripe.portal({ customer: account.customerId, return_url: `${billingBase(ctx)}/#billing` });
    return { url: session.url };
  });

  /**
   * POST /api/stripe/webhook (raw body, Stripe-Signature). Only subscription
   * state is taken from Stripe: checkout.session.completed links the tenant
   * to its customer, customer.subscription.* carries the status. Each event is
   * applied once, in the tenant's write queue; older events never overwrite
   * newer state (Stripe does not guarantee order).
   */
  async function stripeWebhook({ rawBody, signature }, { dispatch = null } = {}) {
    if (!billingOn()) return { status: 404, body: { ok: false, error: 'not found' } };
    let event;
    try { event = await billingCore.verifyWebhook(String(rawBody || ''), signature, billing.config.webhookSecret); } catch (error) {
      return { status: 400, body: { ok: false, error: error.message } };
    }
    await whenReady();
    if (await store.sql.first('SELECT event_id FROM billing_events WHERE event_id = ?', [event.id])) return { status: 200, body: { ok: true, duplicate: true } };
    const o = (event.data && event.data.object) || {};
    const exists = async id => Boolean(id && await store.sql.first('SELECT id FROM tenants WHERE id = ?', [String(id)]));
    let tenantId = null;
    let change = null;
    if (event.type === 'checkout.session.completed' && o.mode === 'subscription') {
      tenantId = o.client_reference_id || (o.metadata || {}).tenant_id;
      const paid = ['paid', 'no_payment_required'].includes(o.payment_status);
      change = { customer: o.customer, subscription: o.subscription, status: paid ? 'active' : 'incomplete', statusIsHint: true };
    } else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(event.type)) {
      const byCustomer = o.customer ? await store.sql.first('SELECT tenant_id FROM billing_accounts WHERE stripe_customer_id = ?', [String(o.customer)]) : null;
      tenantId = byCustomer ? byCustomer.tenant_id : (o.metadata || {}).tenant_id;
      change = { customer: o.customer, subscription: o.id, status: event.type === 'customer.subscription.deleted' ? 'canceled' : String(o.status || '') };
    }
    if (!change || !(await exists(tenantId)) || !change.customer || !change.status) {
      // Not ours or not relevant: acknowledge so Stripe stops retrying.
      await store.sql.batch([{ sql: 'INSERT OR IGNORE INTO billing_events (event_id, tenant_id, type, received_at) VALUES (?, ?, ?, ?)', params: [event.id, null, event.type, new Date().toISOString()] }]);
      return { status: 200, body: { ok: true, ignored: true } };
    }
    const job = { type: 'billing', eventId: event.id, eventType: event.type, created: Number(event.created) || 0, ...change };
    const out = dispatch ? await dispatch(tenantId, job) : await serialize(tenantId, () => runTenantJob(tenantId, job));
    return { status: 200, body: { ok: true, ...(out && typeof out === 'object' ? { applied: Boolean(out.applied) } : {}) } };
  }

  async function applyBillingEvent(tenantId, job) {
    if (await store.sql.first('SELECT event_id FROM billing_events WHERE event_id = ?', [job.eventId])) return { applied: false, duplicate: true };
    const prev = await billingAccount(tenantId);
    const now = new Date().toISOString();
    const stale = prev && job.created && job.created < prev.lastEventAt;
    // A checkout "paid" hint never downgrades a status a subscription event already set.
    const keepStatus = stale || (job.statusIsHint && prev && prev.lastEventAt && prev.customerId === job.customer);
    const status = keepStatus ? prev.status : job.status;
    const next = billingCore.nextAccountState(prev, status, now);
    const u = store.tenant(tenantId).unit()
      .raw(`INSERT INTO billing_accounts (tenant_id, stripe_customer_id, stripe_subscription_id, status, past_due_since, last_event_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, billing_accounts.stripe_subscription_id),
        status = excluded.status, past_due_since = excluded.past_due_since, last_event_at = MAX(billing_accounts.last_event_at, excluded.last_event_at), updated_at = excluded.updated_at`,
      [tenantId, String(job.customer), job.subscription ? String(job.subscription) : null, next.status, next.pastDueSince, job.created || 0, now])
      .raw('INSERT OR IGNORE INTO billing_events (event_id, tenant_id, type, received_at) VALUES (?, ?, ?, ?)', [job.eventId, tenantId, job.eventType, now]);
    if (!prev || prev.status !== next.status) u.audit('billing.status', `${prev ? prev.status : 'none'} -> ${next.status} (Stripe ${job.eventType} ${job.eventId})`, 'stripe');
    await u.commit();
    return { applied: true, status: next.status, stale: Boolean(stale) };
  }

  /**
   * Daily usage to Stripe: door-days (doors in the connected fleet today; demo
   * doors are free) and SMS segments since the last report. A row is written
   * before sending and marked sent after, so retries reuse the identifier.
   */
  async function meterUsage(tenantId) {
    if (!billingOn()) return null;
    const account = await billingAccount(tenantId);
    if (!account || ['canceled', 'incomplete_expired', 'incomplete'].includes(account.status)) return null;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const today = nowIso.slice(0, 10);
    const out = {};
    if (!(await store.sql.first("SELECT 1 AS x FROM billing_reports WHERE tenant_id = ? AND meter = 'door_days' AND report_key = ?", [tenantId, today]))) {
      const vendor = await resolveVendor(tenantId);
      const doors = vendor.demo ? 0 : ((await vendor.listLocks()) || []).length; // throws: retried next run
      await store.sql.batch([{ sql: 'INSERT OR IGNORE INTO billing_reports (tenant_id, meter, report_key, value, event_at) VALUES (?, ?, ?, ?, ?)', params: [tenantId, 'door_days', today, doors, nowIso] }]);
      out.doors = doors;
    }
    const p = today.slice(0, 7);
    const used = await store.sql.first("SELECT n FROM usage_counters WHERE tenant_id = ? AND period = ? AND kind = 'sms_segments'", [tenantId, p]);
    const reported = await store.sql.first("SELECT COALESCE(SUM(value), 0) AS n FROM billing_reports WHERE tenant_id = ? AND meter = 'sms_segments' AND report_key LIKE ?", [tenantId, `${p}:%`]);
    const n = Number((used || {}).n || 0);
    if (billing.config.priceSms && n > Number(reported.n)) {
      await store.sql.batch([{ sql: 'INSERT OR IGNORE INTO billing_reports (tenant_id, meter, report_key, value, event_at) VALUES (?, ?, ?, ?, ?)', params: [tenantId, 'sms_segments', `${p}:${n}`, n - Number(reported.n), nowIso] }]);
    }
    const due = await store.sql.all('SELECT meter, report_key, value, event_at FROM billing_reports WHERE tenant_id = ? AND sent_at IS NULL AND event_at >= ? ORDER BY event_at',
      [tenantId, new Date(nowMs - billingCore.MAX_BACKFILL_DAYS * 864e5).toISOString()]);
    let sent = 0;
    for (const r of due) {
      if (Number(r.value) > 0) {
        await billing.stripe.meterEvent({
          event_name: r.meter === 'door_days' ? billing.config.meterDoorDays : billing.config.meterSms,
          payload: { stripe_customer_id: account.customerId, value: Number(r.value) },
          identifier: `${tenantId}:${r.meter}:${r.report_key}`,
          timestamp: Math.floor(Math.min(Date.parse(r.event_at), nowMs) / 1000),
        }); // throws: the rest waits for the next run
        sent++;
      }
      await store.sql.batch([{ sql: 'UPDATE billing_reports SET sent_at = ? WHERE tenant_id = ? AND meter = ? AND report_key = ?', params: [new Date().toISOString(), tenantId, r.meter, r.report_key] }]);
    }
    if (sent) out.sent = sent;
    return Object.keys(out).length ? out : null;
  }

  route('GET', /^\/api\/platform\/usage$/, async ctx => {
    const p = ctx.query.get('period') || period();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) throw new HttpError(400, 'period must be YYYY-MM');
    const rows = await store.sql.all('SELECT tenant_id, kind, n FROM usage_counters WHERE period = ?', [p]);
    const tenants = await store.listTenants();
    const out = [];
    for (const t of tenants) {
      const mine = rows.filter(r => r.tenant_id === t.id);
      const limits = (((await store.tenantSettings(t.id)) || {}).limits) || {};
      const n = k => Number((mine.find(r => r.kind === k) || {}).n || 0);
      const acct = billingOn() ? await billingAccount(t.id) : null;
      out.push({ tenantId: t.id, name: t.name, sms: n('sms'), smsSegments: n('sms_segments'), smsMonthlyCap: Number.isInteger(limits.smsMonthlyCap) ? limits.smsMonthlyCap : (smsMonthlyCap || null),
        ...(billingOn() ? { doorDays: (await monthUsage(t.id, p)).doorDays, billing: acct ? billingCore.standing(acct) : null } : {}) });
    }
    return { period: p, tenants: out };
  });
  route('PUT', /^\/api\/platform\/tenants\/([^/]+)\/limits$/, async (ctx, [tenantId]) => {
    if (!(await store.listTenants()).some(t => t.id === tenantId)) throw new HttpError(404, 'not found');
    const cap = ctx.body ? ctx.body.smsMonthlyCap : undefined;
    if (!(cap === null || (Number.isInteger(cap) && cap >= 0 && cap <= 1000000))) throw new HttpError(400, 'smsMonthlyCap must be a whole number (0 = no texts) or null (deployment default)');
    const all = (await store.tenantSettings(tenantId)) || {};
    const limits = { ...(all.limits || {}) };
    if (cap === null) delete limits.smsMonthlyCap; else limits.smsMonthlyCap = cap;
    await store.tenant(tenantId).unit()
      .raw("UPDATE tenants SET settings = json_set(COALESCE(settings, '{}'), '$.limits', json(?)) WHERE id = ?", [JSON.stringify(limits), tenantId])
      .audit('tenant.limits', `smsMonthlyCap=${cap === null ? 'default' : cap}`, 'platform').commit();
    return { tenantId, limits };
  });
  route('POST', /^\/api\/platform\/secrets\/reseal$/, async () => rotation().reseal({ actor: 'platform' }));

  /* ---------------------------------------------------------------- */
  /* Copilot (deterministic router; the tools are what an LLM would call) */
  /* ---------------------------------------------------------------- */
  async function copilot(ctx) {
    const q = String(ctx.body.q || '').toLowerCase();
    const snap = await ctx.snap();
    const doors = await ctx.visibleLocks();
    const people = snap.users.filter(ctx.scope.userVisible);
    if (/batter|service|visit|maintenance|replace/.test(q)) {
      const low = doors.filter(x => x.electricQuantity <= 30).sort((a, b) => a.electricQuantity - b.electricQuantity);
      const off = doors.filter(x => !x.hasGateway);
      return '<b>Suggested service run</b><br>' +
        (low.length ? low.map(d => `· <b>${h(d.lockAlias)}</b> — ${Number(d.electricQuantity)}% battery` +
          (d.electricQuantity <= 15 ? ' <span class="tag r">urgent</span>' : '')).join('<br>') : 'No low batteries.') +
        (off.length ? `<br>· <b>${off.map(d => h(d.lockAlias)).join(', ')}</b> — no gateway, cannot be opened remotely` : '') +
        '<br><br>Batching these into one visit saves a second call-out. Shall I draft the job sheet?';
    }
    if (/unusual|anomal|risk|suspicious|odd|wrong/.test(q)) {
      const denials = await ctx.t.auditCount('unlock.denied');
      const suspended = people.filter(u => u.suspended);
      const expiring = people.filter(u => u.validTo && new Date(u.validTo) < new Date(Date.now() + 30 * 864e5));
      const pending = snap.credentials.filter(c => c.status === 'pending_removal' && ctx.scope.lock(c.lockId));
      return '<b>Risk review</b><br>' +
        `· ${denials} denied unlock attempt(s) recorded<br>` +
        `· ${suspended.length} suspended user(s): ${suspended.map(u => h(u.name)).join(', ') || 'none'}<br>` +
        `· ${expiring.length} credential(s) expiring within 30 days: ${expiring.map(u => h(u.name)).join(', ') || 'none'}<br>` +
        `· ${pending.length} code(s) still on offline locks awaiting on-site removal<br><br>` +
        'Recommendation: remove suspended users from all groups so they disappear from reports, and renew expiring contractors before they lock themselves out.';
    }
    if (/who can|who has|access to/.test(q)) {
      const m = q.match(/(server room|main entrance|warehouse|cleaner|gym front|gym staff|storage)/);
      const d = m ? doors.find(x => (x.lockAlias || '').toLowerCase().includes(m[1])) : null;
      if (!d) return 'Name a door and I will list who can open it right now — e.g. "who can open the Server Room?"';
      const names = people.filter(u => policy.evaluate(snap, u.id, d.lockId, new Date()).allowed).map(u => u.name);
      return `<b>${h(d.lockAlias)}</b> — currently openable by: ${names.length ? names.map(h).join(', ') : '<i>nobody at this moment</i>'}.<br><br>This is evaluated live against schedules, so the answer changes with the clock.`;
    }
    if (/denied|why|refus|reject/.test(q)) {
      const m = q.match(/(sarah|dev|tom|cleanco|cleaner)/);
      const u = m ? people.find(x => x.name.toLowerCase().includes(m[1])) : null;
      if (!u) return 'Tell me who was denied — e.g. "why was Sarah denied at 9pm?"';
      // "9pm" means 9pm at each door's own site, not 21:00 UTC.
      const denied = doors.map(d => {
        const tz = policy.siteTimeZone(snap, (policy.siteForLock(snap, d.lockId) || {}).id);
        const today = policy.localParts(new Date(), tz).isoDate;
        return { door: d.lockAlias, r: policy.evaluate(snap, u.id, d.lockId, policy.zonedTimeToDate(`${today}T21:00`, tz)) };
      }).filter(x => !x.r.allowed).slice(0, 4);
      return `<b>${h(u.name)}</b> at 21:00 (each site's local time):<br>` +
        denied.map(x => `· ${h(x.door)}: ${h(x.r.reason)}`).join('<br>') +
        '<br><br>Most denials at that hour come from the <i>Office Hours</i> schedule ending 18:30. To change it, I can extend the window or add an evening exception — your approval required.';
    }
    if (/give|grant|add|allow|extend/.test(q)) {
      return '<b>Proposed change</b> (not yet applied)<br>' +
        'I would add a rule: <b>Cleaning Contractor</b> → <b>Operations</b> on <b>Friday 18:00–21:00</b>.<br><br>' +
        'Impact: 1 user group, 2 doors. No existing rule is removed.<br>' +
        '<i>Nothing is executed until you confirm — every AI action is proposal-then-approve, and lands in the audit log with "ai" as the actor.</i>';
    }
    return 'I can help with:<br>· <b>Diagnostics</b> — "which doors need a battery visit?"<br>' +
      '· <b>Explaining decisions</b> — "why was Sarah denied at 9pm?"<br>' +
      '· <b>Queries</b> — "who can open the Server Room?"<br>' +
      '· <b>Risk review</b> — "anything unusual this week?"<br>' +
      '· <b>Rule drafting</b> — "give the cleaners Friday evening access"<br><br>' +
      '<i>Running on the deterministic router. Set OPENAI_API_KEY to enable full natural language.</i>';
  }

  /* ---------------------------------------------------------------- */
  /* Dispatcher                                                        */
  /* ---------------------------------------------------------------- */
  /* ---------------------------------------------------------------- */
  /* Browser sessions (public routes; they authenticate themselves)     */
  /* ---------------------------------------------------------------- */
  const cookieOpts = req => ({ secure: Boolean(req.secure), sameSite: cookieSameSite });

  async function describeIn(tenantId, operator) {
    const snap = await store.tenant(tenantId).snapshot();
    return { operator: rbac.describe(snap, operator), tenant: snap.tenant };
  }

  const ssoFail = (req, code) => ({ status: 302, redirect: `/?sso_error=${encodeURIComponent(code)}`, cookies: [flowCookie('', { ...cookieOpts(req), maxAgeSec: 0 })] });

  async function tenantForDomain(domain) {
    if (!DOMAIN_RE.test(domain)) return null;
    for (const t of await store.listTenants()) {
      // Only DNS-verified domains route: otherwise anyone could claim
      // "bigcorp.com" and receive BigCorp's sign-ins.
      if (verifiedDomains(((await store.tenantSettings(t.id)) || {}).sso).includes(domain)) return t.id;
    }
    return null;
  }

  const sessionRoutes = {
    async 'POST /api/auth/login'(req, body) {
      const result = await auth.login({ token: body.token, ip: req.ip || 'unknown', allow: (op, tenantId) => ssoRequiredFor(tenantId, op, 'token') });
      if (result.error) return result.error;
      if (result.status) return result; // vetoed: single sign-on required
      const cfg = await ssoSettings(result.tenantId);
      const glass = Boolean(cfg && cfg.enforced && result.operator.role !== 'r_provisioner');
      await store.tenant(result.tenantId).unit()
        .raw('UPDATE operators SET last_login_at = ? WHERE tenant_id = ? AND id = ?', [new Date().toISOString(), result.tenantId, result.operator.id])
        .audit(glass ? 'operator.break_glass' : 'operator.login', glass ? `token sign-in while single sign-on is enforced${result.operator.env ? ' (server bootstrap token)' : ''}` : 'via token', result.operator.id).commit();
      if (glass && alerts) {
        await alerts.send(result.tenantId, 'break_glass', {
          title: 'Break-glass sign-in',
          text: `${result.operator.name || result.operator.id} signed in with a token while single sign-on is enforced. If this was not a planned emergency, revoke the token and review the audit log.`,
          facts: [['Operator', result.operator.id], ['Role', result.operator.role], ['From', req.ip || 'unknown']],
          path: '/#log',
        });
      }
      return {
        status: 200,
        cookies: [sessionCookie(result.cookieValue, { ...cookieOpts(req), maxAgeSec: result.maxAgeSec })],
        body: { ok: true, authenticated: true, via: 'token', csrf: result.csrf, expiresAt: result.expiresAt, ...(await describeIn(result.tenantId, result.operator)) },
      };
    },
    async 'GET /api/auth/session'(req) {
      const found = await auth.sessionFrom(req.headers.cookie || '');
      if (!found) {
        const settings = (await store.tenantSettings(auth.defaultTenant)) || {};
        return { status: 200, body: { ok: true, authenticated: false, sso: Boolean(settings.sso), ...auth.status() } };
      }
      return {
        status: 200,
        body: {
          ok: true, authenticated: true, via: found.session.via, csrf: found.session.csrf, expiresAt: found.session.expiresAt,
          ...auth.status(), ...(await describeIn(found.session.tenantId, found.operator)),
        },
      };
    },
    async 'GET /api/auth/sso/start'(req) {
      const q = req.query instanceof URLSearchParams ? req.query : new URLSearchParams(req.query || {});
      const email = String(q.get('email') || '').trim().toLowerCase().slice(0, 254);
      let tenantId = String(q.get('tenant') || '').slice(0, 64) || null;
      if (!tenantId && email.includes('@')) tenantId = await tenantForDomain(email.split('@').pop());
      tenantId ||= auth.defaultTenant;
      const cfg = ((await store.tenantSettings(tenantId)) || {}).sso;
      if (!cfg) return ssoFail(req, 'not_configured');
      const state = randomB64url(24);
      const nonce = randomB64url(24);
      const codeVerifier = randomB64url(48);
      const redirectUri = `${req.origin}/api/auth/sso/callback`;
      let url;
      try {
        url = await oidc.authorizationUrl({ config: cfg, redirectUri, state, nonce, codeVerifier, loginHint: EMAIL_RE.test(email) ? email : undefined, origin: req.origin });
      } catch (e) {
        log('sso start', e.message);
        return ssoFail(req, 'provider_unavailable');
      }
      await store.saveFlow({ state, tenantId, nonce, codeVerifier, redirectUri, expiresAt: new Date(Date.now() + 600e3).toISOString() });
      return { status: 302, redirect: url, cookies: [flowCookie(state, cookieOpts(req))] };
    },

    async 'GET /api/auth/sso/callback'(req) {
      const q = req.query instanceof URLSearchParams ? req.query : new URLSearchParams(req.query || {});
      if (q.get('error')) return ssoFail(req, 'denied');
      const state = String(q.get('state') || '');
      const flow = state ? await store.takeFlow(state) : null; // single use
      if (!flow) return ssoFail(req, 'expired');
      const bound = flowStateFrom(req.headers.cookie || '');
      if (!bound || !rbac.constantTimeEqual(bound, state)) return ssoFail(req, 'expired');
      const cfg = ((await store.tenantSettings(flow.tenantId)) || {}).sso;
      if (!cfg) return ssoFail(req, 'not_configured');
      const t = store.tenant(flow.tenantId);
      let claims;
      try {
        const clientSecret = cfg.clientSecretEnc ? await decryptSecret(secretsKey, cfg.clientSecretEnc, { tenantId: flow.tenantId, purpose: SSO_PURPOSE }) : null;
        const idToken = await oidc.exchangeCode({ config: cfg, clientSecret, code: String(q.get('code') || ''), redirectUri: flow.redirectUri, codeVerifier: flow.codeVerifier });
        claims = await oidc.verifyIdToken(idToken, { issuer: cfg.issuer, clientId: cfg.clientId, nonce: flow.nonce });
      } catch (e) {
        log('sso callback', e.message);
        await t.unit().audit('operator.login_denied', `via sso: ${e.code || 'error'}`, 'anonymous').commit();
        return ssoFail(req, e.code === 'expired' ? 'expired' : 'failed');
      }
      const deny = async (code, why) => {
        await t.unit().audit('operator.login_denied', `via sso: ${why}`, 'anonymous').commit();
        return ssoFail(req, code);
      };
      // 1) Already linked: the (issuer, subject) pair is the identity. Email is not.
      let op = await store.operatorBySso(claims.iss, claims.sub);
      if (op && op.tenantId !== flow.tenantId) op = null;
      let link = false;
      if (!op) {
        // 2) First login: match an invitation by email — only if the IdP vouches
        //    for the address (nOAuth: unverified "email" claims are attacker-set).
        const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
        const domain = email.split('@')[1] || '-';
        if (!email) return deny('not_invited', 'no email claim');
        if (claims.email_verified !== true && !cfg.trustUnverifiedEmail) return deny('unverified_email', `unverified email (domain ${domain})`);
        if ((cfg.domains || []).length && !cfg.domains.includes(domain)) return deny('not_invited', `domain ${domain} not allowed`);
        op = await store.operatorInvite(flow.tenantId, email);
        if (!op) return deny('not_invited', `no invitation (domain ${domain})`);
        link = true;
      }
      const at = new Date().toISOString();
      const uow = t.unit();
      if (link) {
        uow.raw('UPDATE operators SET sso_issuer = ?, sso_subject = ? WHERE tenant_id = ? AND id = ? AND sso_subject IS NULL', [claims.iss, claims.sub, flow.tenantId, op.id])
          .audit('operator.sso_linked', op.id, op.id);
      }
      await uow.raw('UPDATE operators SET last_login_at = ? WHERE tenant_id = ? AND id = ?', [at, flow.tenantId, op.id])
        .audit('operator.login', 'via sso', op.id).commit();
      const s = await auth.startSession(op, flow.tenantId, 'sso');
      return {
        status: 302, redirect: '/',
        cookies: [sessionCookie(s.cookieValue, { ...cookieOpts(req), maxAgeSec: s.maxAgeSec }), flowCookie('', { ...cookieOpts(req), maxAgeSec: 0 })],
      };
    },

    async 'POST /api/auth/logout'(req) {
      const found = await auth.sessionFrom(req.headers.cookie || '');
      if (found && !rbac.constantTimeEqual(String(req.headers['x-csrf-token'] || ''), found.session.csrf)) {
        return { status: 403, body: { ok: false, error: 'CSRF token missing or invalid' } };
      }
      await auth.logout(req.headers.cookie || '');
      return { status: 200, cookies: clearSessionCookies(cookieOpts(req)), body: { ok: true, authenticated: false } };
    },
  };

  async function handleScim(req, method, path, who) {
    const fail = (status, detail) => ({ status, body: scimErrorBody(status, detail), contentType: SCIM_TYPE, headers: status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined });
    if (who.error) return fail(who.error.status, who.error.body && who.error.body.error || 'unauthorized');
    if (!who.operator || who.operator.anonymous || !who.tenantId) return fail(401, 'a bearer token is required');
    const t = store.tenant(who.tenantId);
    if (!(await t.info())) return fail(403, 'tenant not found');
    if (!rbac.hasPermission(await t.snapshot(), who.operator, 'directory.sync')) return fail(403, 'this token lacks the directory.sync permission');
    if (!/^\/scim\/v2(\/|$)/.test(path)) return fail(404, 'SCIM lives under /scim/v2');
    const query = req.query instanceof URLSearchParams ? req.query : new URLSearchParams(req.query || {});
    const unpaid = await billingBlock(who.tenantId, method, path);
    if (unpaid) return fail(402, unpaid.body.error);
    const adoptDomains = verifiedDomains(await ssoSettings(who.tenantId));
    return scim.handle({ t, tenantId: who.tenantId, method, path, query, body: req.body, origin: req.origin || '', actor: who.operator.id, adoptDomains });
  }

  /** Request context for route handlers (also used to re-run an approved request). */
  function buildCtx({ t, vendor, tenantId, operator, signIn = null, body, query, origin = '', method, path, approval = null }) {
    let snapPromise = null;
    let locksPromise = null;
    const ctx = {
      body, query, t, vendor, origin, tenantId, operator, method, path, approval,
      actor: operator ? operator.id : 'system',
      signIn,
      snap: () => (snapPromise ||= t.snapshot()),
      scope: null,
      /** The lock must belong to THIS tenant's fleet — site scope alone is
       *  not enough (an all-site owner's scope is "everything"). */
      requireLock: async lockId => {
        locksPromise ||= vendor.listLocks();
        const lock = (await locksPromise).find(l => Number(l.lockId) === Number(lockId));
        if (!lock) throw new HttpError(404, 'unknown lock');
        return lock;
      },
      visibleLocks: async () => {
        const snap = await ctx.snap();
        locksPromise ||= vendor.listLocks();
        return (await locksPromise).filter(l => rbac.canAccessLock(snap, operator, l.lockId));
      },
    };
    return ctx;
  }

  async function handle(req) {
    const method = String(req.method || 'GET').toUpperCase() === 'HEAD' ? 'GET' : String(req.method || 'GET').toUpperCase();
    const path = (String(req.path || '/').replace(/\/+$/, '') || '/');
    req.headers = req.headers || {};
    try {
      if (path === '/api/auth' && method === 'GET') return { status: 200, body: { ok: true, ...auth.status() } };
      await whenReady();
      const sessionRoute = sessionRoutes[`${method} ${path}`];
      if (sessionRoute) {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        return await sessionRoute(req, body);
      }

      const isScim = path === '/scim/v2' || path.startsWith('/scim/');
      const found = routes.find(r => r.method === method && r.pattern.test(path));
      const headers = req.headers || {};
      const who = await auth.authenticate({
        method, path, ip: req.ip || 'unknown',
        // SCIM is machine-to-machine: bearer tokens only, never browser cookies.
        authorization: headers.authorization || '', cookie: isScim ? '' : headers.cookie || '', csrf: headers['x-csrf-token'] || '',
      });
      if (isScim) return await handleScim(req, method, path, who);
      if (who.error) return who.error;
      if (!found) return { status: 404, body: { ok: false, error: 'not found' } };

      const params = path.match(found.pattern).slice(1).map(decodeURIComponent);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const query = req.query instanceof URLSearchParams ? req.query : new URLSearchParams(req.query || {});

      if (who.perm === rbac.PLATFORM) {
        const out = await found.fn({ body, query, operator: who.operator }, params);
        return { status: 200, body: { ok: true, ...out } };
      }

      const t = store.tenant(who.tenantId);
      const vendor = await resolveVendor(who.tenantId);
      const ctx = buildCtx({ t, vendor, tenantId: who.tenantId, operator: who.operator, signIn: who.signIn, body, query, origin: req.origin || '', method, path });
      if (!(await t.info())) return { status: 403, body: { ok: false, error: 'tenant not found' } };
      const ssoBlock = await ssoRequiredFor(who.tenantId, who.operator, who.signIn);
      if (ssoBlock) return ssoBlock;
      const snap = await ctx.snap();
      // Roles live in the tenant's own table, so authorization happens here.
      if (!rbac.hasPermission(snap, who.operator, who.perm)) {
        return { status: 403, body: { ok: false, error: 'forbidden', required: who.perm } };
      }
      ctx.scope = scopeFor(snap, who.operator);
      const unpaid = await billingBlock(who.tenantId, method, path);
      if (unpaid) return unpaid;
      const out = await found.fn(ctx, params);
      if (out && out._status) {
        const { _status, ...rest } = out;
        return { status: _status, body: { ok: true, demo: vendor.demo, ...rest } };
      }
      return { status: 200, body: { ok: true, demo: vendor.demo, ...out } };
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, body: { ok: false, error: error.message, ...error.extra } };
      if (error instanceof ValidationError) return { status: 400, body: { ok: false, error: error.message } };
      if (error && (error.name === 'AccountError' || error.name === 'AuditOpsError' || error.name === 'AlertsError' || error.name === 'BillingError')) return { status: error.status, body: { ok: false, error: error.message } };
      if (error && error.status === 409) return { status: 409, body: { ok: false, error: 'conflicting change, please retry' }, headers: { 'retry-after': '2' } };
      if (error && error.status === 501) return { status: 501, body: { ok: false, error: error.message } };
      // Lock vendor unusable (token revoked, TTLock down): say why, never a 500 or an empty fleet.
      // Transient (TTLock down, rate limit) → Retry-After; needs_reconnect / missing key need a human, not a retry.
      if (error && error.status === 503) {
        const reason = error.reason || 'unavailable';
        return { status: 503, body: { ok: false, error: error.message, reason }, headers: reason === 'unavailable' ? { 'retry-after': '30' } : undefined };
      }
      log('api error', error);
      return { status: 500, body: { ok: false, error: String((error && error.message) || error) } };
    }
  }

  /**
   * Scheduled housekeeping for one tenant (never throws): anchor the audit
   * head (daily), apply retention, retry undelivered alerts.
   */
  async function maintainOne(tenantId) {
    const out = { tenantId };
    if (auditOps) {
      try {
        const a = await auditOps.maybeAnchor(tenantId);
        const p = await auditOps.maybePurge(tenantId);
        Object.assign(out, { anchored: a.anchor && !a.skipped ? a.anchor.seq : null, delivery: a.anchor && !a.skipped ? a.anchor.deliveryStatus : undefined, purged: p.purged || 0 });
      } catch (error) {
        log(`maintenance ${tenantId} failed`, error);
        out.error = String(error.message || error);
      }
    }
    if (alerts) {
      const f = await alerts.flush(tenantId);
      if (f.retried || f.error) out.alerts = f;
      const d = await alerts.flushDigest(tenantId);
      if (d) out.digest = d;
    }
    try {
      const n = await pollArrivals(tenantId);
      if (n) out.arrivals = n;
    } catch (error) {
      log(`maintenance ${tenantId} arrival polling failed`, error);
    }
    try {
      // Visitors: personal details are kept only `retentionDays` after the visit ends.
      const { retentionDays } = visitors.settingsOf((await store.tenantSettings(tenantId)) || {});
      const cutoff = new Date(Date.now() - retentionDays * 864e5).toISOString();
      const due = await store.sql.first('SELECT COUNT(*) AS n FROM visits WHERE tenant_id = ? AND erased_at IS NULL AND end_at < ?', [tenantId, cutoff]);
      if (due && Number(due.n)) {
        await store.tenant(tenantId).unit()
          .raw('UPDATE visits SET visitor_name = NULL, visitor_email = NULL, visitor_phone = NULL, company = NULL, checkout_token_hash = NULL, erased_at = ? WHERE tenant_id = ? AND erased_at IS NULL AND end_at < ?', [new Date().toISOString(), tenantId, cutoff])
          .audit('visits.erased', `${Number(due.n)} visit(s) ended more than ${retentionDays} days ago`, 'system').commit();
        out.visitsErased = Number(due.n);
      }
      // Invitations: the address and what the visitor typed go after the same period.
      await store.sql.batch([
        { sql: "UPDATE visit_invites SET status = 'expired', token_hash = NULL WHERE tenant_id = ? AND status IN ('open', 'submitted') AND expires_at <= ?", params: [tenantId, new Date().toISOString()] },
        { sql: 'UPDATE visit_invites SET contact = NULL, submitted_name = NULL, submitted_company = NULL, erased_at = ? WHERE tenant_id = ? AND erased_at IS NULL AND expires_at < ?', params: [new Date().toISOString(), tenantId, cutoff] },
      ]);
    } catch (error) {
      log(`maintenance ${tenantId} visitor retention failed`, error);
    }
    try {
      const h = await checkLockHealth(tenantId);
      if (h && Object.keys(h).length) Object.assign(out, h);
    } catch (error) {
      log(`maintenance ${tenantId} lock health failed`, error);
    }
    try {
      const b = await meterUsage(tenantId);
      if (b) out.billing = b;
    } catch (error) {
      log(`maintenance ${tenantId} billing usage failed`, error && error.message);
      out.billingError = String((error && error.message) || error);
    }
    try {
      // Snapshot-cache change log: keep the newest rows; caches further behind reload in full.
      const pruned = await store.tenant(tenantId).pruneChanges();
      if (pruned) out.changesPruned = pruned;
    } catch (error) {
      log(`maintenance ${tenantId} prune failed`, error);
    }
    return out;
  }

  async function maintenance() {
    const results = [];
    for (const id of await tenantIds()) results.push(await serialize(id, () => maintainOne(id)));
    return results;
  }

  // `routes` is exported for the cross-tenant fuzz gate (test/isolation.fuzz.test.js).
  /** Tenant whose write queue this request belongs to; null for reads and unknown callers. */
  async function writeKey(req) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
    const path = String(req.path || '');
    const headers = req.headers || {};
    try {
      return await auth.tenantHint({ authorization: headers.authorization || '', cookie: path.startsWith('/scim/') ? '' : headers.cookie || '' });
    } catch { return null; } // store not ready yet etc.: handle unqueued, authenticate() decides
  }

  return { handle, writeKey, tenantIds, reconcileOne, maintainOne, reconcileAll, maintenance, reconcileTenant, whenReady, ttlockNotify, recordArrival, recordAlarm, runTenantJob, visitCheckoutPublic, visitInvitePublic, stripeWebhook, routes: routes.map(r => ({ method: r.method, pattern: r.pattern })) };
}

module.exports = { createApi, scopeFor, createDetail, HttpError };
