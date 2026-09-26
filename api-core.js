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
const compiler = require('./compiler-core');
const reconciler = require('./reconcile-core');
const { validate, ValidationError, escapeHtml: h, referencedBy } = require('./validate-core');
const { sha256Hex } = require('./audit-core');
const { operatorStatement } = require('./store/repo');
const { sessionCookie, clearSessionCookies, flowCookie, flowStateFrom } = require('./cookies');
const { createOidcClient, randomB64url } = require('./oidc-core');
const { encryptSecret, decryptSecret } = require('./secrets-core');
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
  secretsKey = '', fetchFn, allowHttpIssuers = false, oidc = createOidcClient({ fetchFn }),
}) {
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
  async function reconcileTenant(tenantId, { userId = null, lockFilter = () => true, dryRun = false, actor } = {}) {
    const t = store.tenant(tenantId);
    const vendor = vendorFor(tenantId);
    const [snap, locks] = await Promise.all([t.snapshot(), vendor.listLocks()]);
    const planned = reconciler.plan(snap, locks, { userId, lockFilter });
    if (dryRun || !planned.actions.length) return { dryRun, plan: planned, summary: { revoked: 0, expired: 0, pendingRemoval: 0, failed: 0 } };
    const uow = t.unit();
    const outcome = await reconciler.execute(planned, { vendor, uow, snapshot: snap, actor });
    await uow.commit();
    return { dryRun, plan: planned, ...outcome };
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

  async function reconcileAll() {
    await whenReady();
    const results = [];
    for (const tenant of await store.listTenants()) {
      if (!tenant.seeded) continue;
      try {
        const out = await reconcileTenant(tenant.id, { actor: reconciler.ACTOR });
        results.push({ tenantId: tenant.id, ...out.summary, notices: out.plan.notices.length });
      } catch (error) {
        log(`reconcile ${tenant.id} failed`, error);
        results.push({ tenantId: tenant.id, error: String(error.message || error) });
      }
    }
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
  route('GET', /^\/api\/permissions$/, async ctx => ({ perms: rbac.PERMS, roles: (await ctx.snap()).roles }));
  route('GET', /^\/api\/status$/, async ctx => ({ ...ctx.vendor.status(), tenant: (await ctx.snap()).tenant }));

  // --- doors ---------------------------------------------------------
  route('GET', /^\/api\/doors$/, async ctx => {
    const snap = await ctx.snap();
    const doors = (await ctx.visibleLocks()).map(l => {
      const dg = snap.doorGroups.find(d => (d.lockIds || []).map(Number).includes(Number(l.lockId)));
      const site = dg ? snap.sites.find(s => s.id === dg.siteId) : null;
      return { ...l, doorGroup: dg ? dg.name : null, site: site ? site.name : (l.groupName || 'Unassigned') };
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

  // --- collections (CRUD) ----------------------------------------------
  for (const coll of COLLECTIONS) {
    route('GET', new RegExp(`^/api/${coll}$`), async ctx => ({ [coll]: ctx.scope.filter(coll, (await ctx.snap())[coll]) }));

    route('POST', new RegExp(`^/api/${coll}$`), async ctx => {
      const snap = await ctx.snap();
      const clean = validate(coll, ctx.body, snap);
      if (!ctx.scope.canWrite(coll, clean)) {
        throw outOfScope(coll === 'users' ? 'every groupId must belong to one of your sites' : `creating ${coll} here needs all-site scope`);
      }
      const item = { ...clean, id: policy.uid(coll.slice(0, 3)) }; // server owns ids
      await ctx.t.unit().insert(coll, item).audit(`${coll}.create`, createDetail(coll, item), ctx.actor).commit();
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

  // --- credentials -----------------------------------------------------
  route('POST', /^\/api\/passcode$/, async ctx => {
    const snap = await ctx.snap();
    const { lockId, name, userId, startAt, endAt, acknowledgeScheduleGap } = ctx.body;
    if (lockId === undefined || lockId === null || lockId === '') throw new HttpError(400, 'lockId is required');
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
    const out = await ctx.vendor.createPasscode({ lockId: c.lockId, name: String(name || `AccessX ${userId}`).slice(0, 100), startAt: c.startAt, endAt: c.endAt });
    const entry = creds.register({ credentials: [] }, c, { issuedBy: ctx.actor, vendorRef: out.keyboardPwdId, code: out.keyboardPwd });
    entry.vendorRef = entry.vendorRef === null || entry.vendorRef === undefined ? null : String(entry.vendorRef);
    await ctx.t.unit().insert('credentials', entry)
      .audit('passcode.create', `${entry.id} lock ${c.lockId} user ${userId} ${c.startAt}..${c.endAt} enforcement=${c.enforcement}` +
        (plan.warnings.length ? ` warnings: ${plan.warnings.join(' | ')}` : ''), ctx.actor)
      .commit();
    // The full code is returned exactly once and never stored.
    return { passcode: out, credential: entry, warnings: plan.warnings };
  });

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
    // SSO operators get an unusable random token hash: they can only sign in
    // through the identity provider (and are cut off when IT disables them there).
    const token = viaSso ? null : `ax_${randomToken()}`;
    const op = { id: policy.uid('op'), name, role: b.role, siteIds, email, tokenSha256: sha256Hex(token || `unusable:${randomToken()}`), createdBy: ctx.actor };
    const stmt = operatorStatement(ctx.tenantId, op);
    await ctx.t.unit().raw(stmt.sql, stmt.params)
      .audit('operator.create', `${op.id} role=${op.role} sites=${siteIds.join(',') || '*'}${viaSso ? ' auth=sso' : ''}`, ctx.actor).commit();
    const operator = { id: op.id, name, role: op.role, siteIds, email: email || undefined, auth: viaSso ? 'sso' : 'token' };
    // Token shown once; only the hash is stored.
    return viaSso ? { operator, invited: true } : { operator, token };
  });

  route('DELETE', /^\/api\/operators\/([^/]+)$/, async (ctx, [id]) => {
    await ctx.snap();
    if (id === ctx.operator.id) throw new HttpError(409, 'you cannot revoke your own access');
    const target = (await ctx.t.operators()).find(o => o.id === id && !o.revokedAt);
    if (!target) throw new HttpError(404, 'not found');
    if (!ctx.scope.all && (!(target.siteIds || []).length || target.siteIds.some(s => !ctx.scope.site(s)))) throw outOfScope('operator is outside your sites');
    const at = new Date().toISOString();
    await ctx.t.unit().raw('UPDATE operators SET revoked_at = ? WHERE tenant_id = ? AND id = ?', [at, ctx.tenantId, id])
      .raw('UPDATE sessions SET revoked_at = ? WHERE tenant_id = ? AND operator_id = ? AND revoked_at IS NULL', [at, ctx.tenantId, id])
      .audit('operator.revoke', id, ctx.actor).commit();
    return { revoked: id };
  });

  // --- single sign-on configuration (owner only) ----------------------------
  const SSO_PURPOSE = 'sso.clientSecret';
  const publicSso = (cfg, origin) => ({
    sso: cfg ? { issuer: cfg.issuer, clientId: cfg.clientId, domains: cfg.domains || [], trustUnverifiedEmail: Boolean(cfg.trustUnverifiedEmail), hasClientSecret: Boolean(cfg.clientSecretEnc), updatedAt: cfg.updatedAt } : null,
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
    // First tenant to claim a domain keeps it (email → tenant routing must be unambiguous).
    for (const other of await store.listTenants()) {
      if (other.id === ctx.tenantId) continue;
      const theirs = ((await store.tenantSettings(other.id)) || {}).sso;
      const clash = theirs && (theirs.domains || []).find(d => domains.includes(d));
      if (clash) throw new HttpError(409, `domain ${clash} is already claimed by another account`);
    }
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
    const sso = { issuer: issuerStr, clientId, domains, trustUnverifiedEmail: b.trustUnverifiedEmail === true, clientSecretEnc, updatedAt: new Date().toISOString() };
    await saveSettings(ctx, { ...settings, sso })
      .audit('sso.configure', `issuer=${issuerStr} client=${clientId} domains=${domains.join(',') || '-'} secret=${secretNote}${sso.trustUnverifiedEmail ? ' trustUnverifiedEmail' : ''}`, ctx.actor).commit();
    return publicSso(sso, ctx.origin);
  });

  route('DELETE', /^\/api\/sso$/, async ctx => {
    const settings = (await store.tenantSettings(ctx.tenantId)) || {};
    if (!settings.sso) throw new HttpError(404, 'single sign-on is not configured');
    const { sso, ...rest } = settings;
    await saveSettings(ctx, rest)
      .raw("UPDATE sessions SET revoked_at = ? WHERE tenant_id = ? AND via = 'sso' AND revoked_at IS NULL", [new Date().toISOString(), ctx.tenantId])
      .audit('sso.remove', sso.issuer, ctx.actor).commit();
    return publicSso(null, ctx.origin);
  });

  // --- reports ------------------------------------------------------------
  route('GET', /^\/api\/reports\/revocation$/, async ctx => {
    const days = Math.min(Math.max(Number(ctx.query.get('days')) || 30, 1), 365);
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

  // --- vendor / mirror / health ---------------------------------------------
  route('GET', /^\/api\/vendor$/, async ctx => ctx.vendor.info());
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
      const sso = ((await store.tenantSettings(t.id)) || {}).sso;
      if (sso && (sso.domains || []).includes(domain)) return t.id;
    }
    return null;
  }

  const sessionRoutes = {
    async 'POST /api/auth/login'(req, body) {
      const result = await auth.login({ token: body.token, ip: req.ip || 'unknown' });
      if (result.error) return result.error;
      await store.tenant(result.tenantId).unit()
        .raw('UPDATE operators SET last_login_at = ? WHERE tenant_id = ? AND id = ?', [new Date().toISOString(), result.tenantId, result.operator.id])
        .audit('operator.login', 'via token', result.operator.id).commit();
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
    return scim.handle({ t, tenantId: who.tenantId, method, path, query, body: req.body, origin: req.origin || '', actor: who.operator.id });
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
      const vendor = vendorFor(who.tenantId);
      let snapPromise = null;
      let locksPromise = null;
      const ctx = {
        body, query, t, vendor,
        origin: req.origin || '',
        tenantId: who.tenantId,
        operator: who.operator,
        actor: who.operator ? who.operator.id : 'system',
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
          return (await locksPromise).filter(l => rbac.canAccessLock(snap, who.operator, l.lockId));
        },
      };
      if (!(await t.info())) return { status: 403, body: { ok: false, error: 'tenant not found' } };
      const snap = await ctx.snap();
      // Roles live in the tenant's own table, so authorization happens here.
      if (!rbac.hasPermission(snap, who.operator, who.perm)) {
        return { status: 403, body: { ok: false, error: 'forbidden', required: who.perm } };
      }
      ctx.scope = scopeFor(snap, who.operator);
      const out = await found.fn(ctx, params);
      return { status: 200, body: { ok: true, demo: vendor.demo, ...out } };
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, body: { ok: false, error: error.message, ...error.extra } };
      if (error instanceof ValidationError) return { status: 400, body: { ok: false, error: error.message } };
      if (error && error.status === 409) return { status: 409, body: { ok: false, error: 'conflicting change, please retry' } };
      if (error && error.status === 501) return { status: 501, body: { ok: false, error: error.message } };
      log('api error', error);
      return { status: 500, body: { ok: false, error: String((error && error.message) || error) } };
    }
  }

  return { handle, reconcileAll, reconcileTenant, whenReady };
}

module.exports = { createApi, scopeFor, createDetail, HttpError };
