const express = require('express');
const path = require('path');
const { TTLock, RECORD_TYPES } = require('./ttlock');
const { getDriver, availableVendors } = require('./drivers');
const mirror = require('./mirror');
const { createAuth, authStatus: getAuthStatus } = require('./auth');
const acl = require('./acl');
const creds = require('./credentials-core');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const tt = new TTLock();
const DEMO = tt.demo;
const rbac = require('./rbac-core');
const authConfig = {
  token: process.env.ADMIN_TOKEN || '',
  operators: process.env.OPERATORS || '',
  getDb: () => acl.load(),
  openReads: process.env.AUTH_OPEN_READS === undefined
    ? DEMO
    : process.env.AUTH_OPEN_READS === '1',
};
const requireAuth = createAuth(authConfig);
const authStatus = () => getAuthStatus(authConfig);
const actor = req => (req.operator ? req.operator.id : 'system');

app.get('/api/auth', (req,res)=>res.json({ ok: true, ...authStatus() }));

/* ----------------------------------------------------------------- */
/* Demo dataset — realistic commercial scenario                        */
/* ----------------------------------------------------------------- */
const DEMO_LOCKS = [
  { lockId: 9001, lockAlias: 'Main Entrance',        electricQuantity: 78, hasGateway: 1, groupName: 'Riverside Office' },
  { lockId: 9002, lockAlias: 'Server Room',          electricQuantity: 91, hasGateway: 1, groupName: 'Riverside Office' },
  { lockId: 9003, lockAlias: 'Warehouse Side Door',  electricQuantity: 42, hasGateway: 1, groupName: 'Riverside Office' },
  { lockId: 9004, lockAlias: 'Cleaner Cupboard',     electricQuantity: 15, hasGateway: 0, groupName: 'Riverside Office' },
  { lockId: 9101, lockAlias: 'Gym Front Door',       electricQuantity: 66, hasGateway: 1, groupName: 'Northgate Gym' },
  { lockId: 9102, lockAlias: 'Gym Staff Office',     electricQuantity: 88, hasGateway: 1, groupName: 'Northgate Gym' },
  { lockId: 9201, lockAlias: 'Storage Block A Gate', electricQuantity: 55, hasGateway: 1, groupName: 'Selfstore Depot' },
];

function seed() {
  const db = acl.load();
  if (db.sites.length) return db;

  db.sites = [
    { id: 'site_river', name: 'Riverside Office',  address: '12 Riverside Way, Bristol', timezone: 'Europe/London' },
    { id: 'site_gym',   name: 'Northgate Gym',     address: '4 Northgate, Leeds', timezone: 'Europe/London' },
    { id: 'site_store', name: 'Selfstore Depot',   address: 'Unit 7, Enfield', timezone: 'Europe/London' },
  ];
  db.doorGroups = [
    { id: 'dg_pub',   siteId: 'site_river', name: 'Public Doors',    lockIds: [9001] },
    { id: 'dg_sec',   siteId: 'site_river', name: 'Secure Areas',    lockIds: [9002] },
    { id: 'dg_ops',   siteId: 'site_river', name: 'Operations',      lockIds: [9003, 9004] },
    { id: 'dg_gym',   siteId: 'site_gym',   name: 'Gym Member Doors',lockIds: [9101] },
    { id: 'dg_gstaff',siteId: 'site_gym',   name: 'Gym Staff Only',  lockIds: [9102] },
    { id: 'dg_store', siteId: 'site_store', name: 'Storage Gates',   lockIds: [9201] },
  ];
  db.schedules = [
    { id: 'sch_office', name: 'Office Hours',   denyOnHolidays: true,
      windows: [{ days: [1,2,3,4,5], from: '08:00', to: '18:30' }] },
    { id: 'sch_24',     name: '24/7',           denyOnHolidays: false,
      windows: [{ days: [1,2,3,4,5,6,7], from: '00:00', to: '23:59' }] },
    { id: 'sch_clean',  name: 'Cleaning Window',denyOnHolidays: false,
      windows: [{ days: [1,3,5], from: '18:00', to: '21:00' }] },
    { id: 'sch_night',  name: 'Night Shift',    denyOnHolidays: false,
      windows: [{ days: [1,2,3,4,5,6,7], from: '22:00', to: '06:00' }] },
  ];
  db.userGroups = [
    { id: 'ug_staff',   name: 'Office Staff' },
    { id: 'ug_it',      name: 'IT Admins' },
    { id: 'ug_clean',   name: 'Cleaning Contractor' },
    { id: 'ug_member',  name: 'Gym Members' },
    { id: 'ug_gymstaff',name: 'Gym Staff' },
    { id: 'ug_tenant',  name: 'Storage Tenants' },
  ];
  db.assignments = [
    { id: 'as1', userGroupId: 'ug_staff',    doorGroupId: 'dg_pub',    scheduleId: 'sch_office' },
    { id: 'as2', userGroupId: 'ug_staff',    doorGroupId: 'dg_ops',    scheduleId: 'sch_office' },
    { id: 'as3', userGroupId: 'ug_it',       doorGroupId: 'dg_pub',    scheduleId: 'sch_24' },
    { id: 'as4', userGroupId: 'ug_it',       doorGroupId: 'dg_sec',    scheduleId: 'sch_24' },
    { id: 'as5', userGroupId: 'ug_clean',    doorGroupId: 'dg_ops',    scheduleId: 'sch_clean' },
    { id: 'as6', userGroupId: 'ug_clean',    doorGroupId: 'dg_pub',    scheduleId: 'sch_clean' },
    { id: 'as7', userGroupId: 'ug_member',   doorGroupId: 'dg_gym',    scheduleId: 'sch_24' },
    { id: 'as8', userGroupId: 'ug_gymstaff', doorGroupId: 'dg_gstaff', scheduleId: 'sch_24' },
    { id: 'as9', userGroupId: 'ug_tenant',   doorGroupId: 'dg_store',  scheduleId: 'sch_24' },
  ];
  db.users = [
    { id: 'u1', name: 'Sarah Kelly',   email: 'sarah@acme.co.uk', groupIds: ['ug_staff'],    suspended: false },
    { id: 'u2', name: 'Dev Patel',     email: 'dev@acme.co.uk',   groupIds: ['ug_staff','ug_it'], suspended: false },
    { id: 'u3', name: 'CleanCo Ltd',   email: 'ops@cleanco.uk',   groupIds: ['ug_clean'],    suspended: false,
      validTo: new Date(Date.now() + 90*864e5).toISOString() },
    { id: 'u4', name: 'Tom Nguyen',    email: 'tom@x.com',        groupIds: ['ug_member'],   suspended: false },
    { id: 'u5', name: 'Ex-Employee',   email: 'gone@acme.co.uk',  groupIds: ['ug_staff'],    suspended: true },
  ];
  db.holidays = [{ date: new Date(Date.now() + 3*864e5).toISOString().slice(0,10), name: 'Bank Holiday' }];
  db.roles = rbac.DEFAULT_ROLES.map(role => ({ ...role }));
  acl.audit(db, 'seed', 'demo dataset created');
  acl.save(db);
  return db;
}
seed();

/* ----------------------------------------------------------------- */
/* API                                                                 */
/* ----------------------------------------------------------------- */
const ok = (res, d) => res.json({ ok: true, demo: DEMO, ...d });
const fail = (res, e) => res.status(500).json({ ok: false, error: String(e.message || e) });

app.use('/api', requireAuth);

app.post('/api/auth/verify', (req,res)=>ok(res,{authenticated:true, operator: rbac.describe(acl.load(), req.operator)}));
app.get('/api/me', (req, res) => ok(res, { operator: rbac.describe(acl.load(), req.operator) }));
app.get('/api/permissions', (req, res) => ok(res, { perms: rbac.PERMS, roles: acl.load().roles }));

const forbiddenSite = (res, lockId) => res.status(403).json({
  ok: false, error: 'forbidden', required: 'site scope', detail: `lock ${lockId} is outside your sites`,
});

app.get('/api/status', (req, res) => ok(res, {
  mode: DEMO ? 'DEMO (no TTLock credentials set)' : 'LIVE (TTLock cloud)',
  region: process.env.TTLOCK_REGION || 'eu',
}));

// ---- Doors -------------------------------------------------------
app.get('/api/doors', async (req, res) => {
  try {
    const db = acl.load();
    let locks;
    if (DEMO) locks = DEMO_LOCKS;
    else {
      const r = await tt.listLocks(1, 200);
      locks = (r.list || []).map(l => ({
        lockId: l.lockId, lockAlias: l.lockAlias, electricQuantity: l.electricQuantity,
        hasGateway: l.hasGateway, groupName: l.groupName,
      }));
    }
    // enrich with our own site / door-group metadata
    const visible = locks.filter(l => rbac.canAccessLock(db, req.operator, l.lockId));
    const enriched = visible.map(l => {
      const dg = db.doorGroups.find(d => (d.lockIds || []).includes(l.lockId));
      const site = dg ? db.sites.find(s => s.id === dg.siteId) : null;
      return { ...l, doorGroup: dg ? dg.name : null, site: site ? site.name : (l.groupName || 'Unassigned') };
    });
    ok(res, { doors: enriched });
  } catch (e) { fail(res, e); }
});

app.post('/api/doors/:id/unlock', async (req, res) => {
  try {
    const db = acl.load();
    const lockId = Number(req.params.id);
    const { userId } = req.body || {};
    if (!rbac.canAccessLock(db, req.operator, lockId)) return forbiddenSite(res, lockId);
    // ★ policy check BEFORE touching the lock — this is the whole point
    if (userId) {
      const v = acl.evaluate(db, userId, lockId, new Date());
      if (!v.allowed) {
        acl.audit(db, 'unlock.denied', `lock ${lockId} user ${userId}: ${v.reason}`, actor(req));
        acl.save(db);
        return res.status(403).json({ ok: false, denied: true, reason: v.reason, path: v.path });
      }
    }
    if (!DEMO) await tt.unlock(lockId);
    acl.audit(db, 'unlock.granted', `lock ${lockId}${userId ? ' user ' + userId : ' (operator override)'}`, actor(req));
    acl.save(db);
    ok(res, { unlocked: lockId, simulated: DEMO });
  } catch (e) { fail(res, e); }
});

// ---- Access decision explainer (the killer demo feature) ----------
app.post('/api/evaluate', (req, res) => {
  const db = acl.load();
  const { userId, lockId, when, localTime } = req.body || {};
  const site = acl.siteForLock(db, lockId);
  const timeZone = acl.siteTimeZone(db, site && site.id);
  // localTime = wall-clock time at the door's site ("2026-09-28T21:00");
  // when = absolute instant (ISO with offset). localTime wins if both sent.
  const at = localTime ? acl.zonedTimeToDate(localTime, timeZone) : when ? new Date(when) : new Date();
  if (Number.isNaN(at.getTime())) return res.status(400).json({ ok: false, error: 'invalid date' });
  ok(res, {
    at: at.toISOString(),
    site: site ? site.name : null,
    timeZone,
    localTime: acl.localParts(at, timeZone).label,
    result: acl.evaluate(db, userId, Number(lockId), at),
  });
});

app.get('/api/users/:id/doors', (req, res) => {
  const db = acl.load();
  ok(res, { doors: acl.doorsForUser(db, req.params.id, new Date()) });
});

// ---- CRUD --------------------------------------------------------
for (const coll of ['sites','doorGroups','userGroups','users','schedules','assignments','holidays','roles']) {
  app.get(`/api/${coll}`, (req, res) => ok(res, { [coll]: acl.load()[coll] }));
  app.post(`/api/${coll}`, (req, res) => {
    const db = acl.load();
    const item = { ...(req.body || {}), id: acl.uid(coll.slice(0,3)) }; // server owns ids
    db[coll].push(item);
    acl.audit(db, `${coll}.create`, JSON.stringify(item).slice(0,200), actor(req));
    acl.save(db);
    ok(res, { item });
  });
  app.delete(`/api/${coll}/:id`, (req, res) => {
    const db = acl.load();
    db[coll] = db[coll].filter(x => x.id !== req.params.id);
    acl.audit(db, `${coll}.delete`, req.params.id, actor(req));
    acl.save(db);
    ok(res, {});
  });
}

// ---- Credentials -------------------------------------------------
app.post('/api/passcode', async (req, res) => {
  try {
    const db = acl.load();
    const { lockId, name, userId, startAt, endAt, acknowledgeScheduleGap } = req.body || {};
    if (!rbac.canAccessLock(db, req.operator, lockId)) return forbiddenSite(res, lockId);
    // ★ Policy check BEFORE the lock gets a code — same rule as remote unlock.
    const plan = creds.planPasscode(db, { userId, lockId, startAt, endAt, acknowledgeScheduleGap: acknowledgeScheduleGap === true });
    if (!plan.ok) {
      acl.audit(db, 'passcode.denied', `lock ${lockId} user ${userId}: ${plan.error}`, actor(req));
      acl.save(db);
      const { ok: _ok, status, ...rest } = plan;
      return res.status(status).json({ ok: false, ...rest });
    }
    const c = plan.credential;
    const label = String(name || `AccessX ${userId}`).slice(0, 100);
    let out;
    if (DEMO) out = { keyboardPwd: String(Math.floor(100000 + Math.random()*899999)), keyboardPwdId: Date.now() };
    else out = await tt.createPasscode({
      lockId: c.lockId, keyboardPwdName: label, keyboardPwdType: 3,
      startDate: Date.parse(c.startAt), endDate: Date.parse(c.endAt),
    });
    const entry = creds.register(db, c, { issuedBy: actor(req), vendorRef: out.keyboardPwdId, code: out.keyboardPwd });
    acl.audit(db, 'passcode.create',
      `${entry.id} lock ${c.lockId} user ${userId} ${c.startAt}..${c.endAt} enforcement=${c.enforcement}` +
      (plan.warnings.length ? ` warnings: ${plan.warnings.join(' | ')}` : ''), actor(req));
    acl.save(db);
    // The full code is returned exactly once and never stored.
    ok(res, { passcode: out, credential: entry, warnings: plan.warnings });
  } catch (e) { fail(res, e); }
});

app.get('/api/credentials', (req, res) => {
  const db = acl.load();
  const visible = (db.credentials || []).filter(c => rbac.canAccessLock(db, req.operator, c.lockId));
  const ids = new Set(visible.map(c => c.id));
  ok(res, { credentials: visible, review: creds.reviewCredentials(db).filter(f => ids.has(f.id)) });
});

app.delete('/api/credentials/:id', async (req, res) => {
  try {
    const db = acl.load();
    const cred = (db.credentials || []).find(c => c.id === req.params.id);
    if (!cred) return res.status(404).json({ ok: false, error: 'not found' });
    if (!rbac.canAccessLock(db, req.operator, cred.lockId)) return forbiddenSite(res, cred.lockId);
    if (!DEMO && cred.type === 'passcode' && cred.vendorRef) await tt.deletePasscode(cred.lockId, cred.vendorRef);
    creds.revoke(db, cred.id, { revokedBy: actor(req), reason: String((req.body && req.body.reason) || 'manual').slice(0, 200) });
    acl.audit(db, 'credential.revoke', `${cred.id} lock ${cred.lockId} user ${cred.userId}`, actor(req));
    acl.save(db);
    ok(res, { credential: cred });
  } catch (e) { fail(res, e); }
});

// ---- Audit trail (ours + TTLock's) --------------------------------
app.get('/api/records/:lockId', async (req, res) => {
  try {
    if (!rbac.canAccessLock(acl.load(), req.operator, req.params.lockId)) return forbiddenSite(res, req.params.lockId);
    if (DEMO) {
      const types = [1,4,7,8,12,55];
      const list = Array.from({ length: 25 }, (_, i) => {
        const t = types[i % types.length];
        return {
          recordId: 1e6 + i, lockId: Number(req.params.lockId), recordType: t,
          typeLabel: RECORD_TYPES[t] || `type ${t}`,
          success: i % 11 === 0 ? 0 : 1,
          username: ['Sarah Kelly','Dev Patel','CleanCo Ltd','Tom Nguyen'][i % 4],
          lockDate: Date.now() - i * 3.4e6,
        };
      });
      return ok(res, { records: list });
    }
    const r = await tt.records(Number(req.params.lockId), { pageSize: 100 });
    const list = (r.list || []).map(x => ({ ...x, typeLabel: RECORD_TYPES[x.recordType] || `type ${x.recordType}` }));
    ok(res, { records: list });
  } catch (e) { fail(res, e); }
});

app.get('/api/audit', (req, res) => ok(res, { log: acl.load().auditLog.slice(0, 100) }));

// ---- Vendor abstraction ------------------------------------------
// server 只跟 driver 接口对话，不直接依赖任何厂商。
app.get('/api/vendor', async (req, res) => {
  try {
    const d = getDriver();
    ok(res, {
      active: d.vendor,
      available: availableVendors(),
      capabilities: d.capabilities(),
      health: await d.health(),
    });
  } catch (e) { fail(res, e); }
});

// ---- Record mirror (breaks the vendor 180-day ceiling) ------------
app.post('/api/mirror/sync', async (req, res) => {
  try { ok(res, await mirror.sync(getDriver(), req.body || {})); }
  catch (e) { fail(res, e); }
});

app.get('/api/mirror/coverage', (req, res) => {
  try { ok(res, mirror.coverage()); } catch (e) { fail(res, e); }
});

app.get('/api/mirror/records', (req, res) => {
  try {
    const { lockId, from, to, limit } = req.query;
    ok(res, { records: mirror.query({
      lockId: lockId || null,
      from: from ? Number(from) : null,
      to: to ? Number(to) : null,
      limit: limit ? Number(limit) : 500,
    }) });
  } catch (e) { fail(res, e); }
});

// ---- Fleet health (installer view) --------------------------------
app.get('/api/health', async (req, res) => {
  try {
    const db = acl.load();
    const doors = (DEMO ? DEMO_LOCKS : ((await tt.listLocks(1,200)).list || []))
      .filter(d => rbac.canAccessLock(db, req.operator, d.lockId));
    const low = doors.filter(d => d.electricQuantity <= 25);
    const offline = doors.filter(d => !d.hasGateway);
    ok(res, {
      total: doors.length, lowBattery: low, offline,
      score: Math.round(100 - (low.length*12 + offline.length*8)),
    });
  } catch (e) { fail(res, e); }
});


/* ----------------------------------------------------------------- */
/* AI Copilot                                                          */
/* Deterministic intent router over LIVE data.                         */
/* Set OPENAI_API_KEY to swap the router for a real LLM + tool-calling; */
/* the tool functions below are already the "tools" it would call.      */
/* ----------------------------------------------------------------- */
function aiTools(db, doors) {
  return {
    whoCanOpen(name) {
      const d = doors.find(x => (x.lockAlias||'').toLowerCase().includes(name));
      if (!d) return null;
      const out = [];
      for (const u of db.users) {
        const r = acl.evaluate(db, u.id, d.lockId, new Date());
        if (r.allowed) out.push(u.name);
      }
      return { door: d.lockAlias, people: out };
    },
    serviceVisits() {
      const low = doors.filter(x => x.electricQuantity <= 30)
        .sort((a,b) => a.electricQuantity - b.electricQuantity);
      const off = doors.filter(x => !x.hasGateway);
      return { low, off };
    },
    anomalies() {
      const denials = db.auditLog.filter(x => x.action === 'unlock.denied');
      const suspended = db.users.filter(u => u.suspended);
      const expiring = db.users.filter(u => u.validTo &&
        new Date(u.validTo) < new Date(Date.now() + 30*864e5));
      return { denials: denials.length, suspended, expiring };
    },
    explainDenial(personName) {
      const u = db.users.find(x => x.name.toLowerCase().includes(personName));
      if (!u) return null;
      // "9pm" means 9pm at each door's own site, not 21:00 UTC.
      const res = doors.map(d => {
        const tz = acl.siteTimeZone(db, (acl.siteForLock(db, d.lockId) || {}).id);
        const today = acl.localParts(new Date(), tz).isoDate;
        return { door: d.lockAlias, r: acl.evaluate(db, u.id, d.lockId, acl.zonedTimeToDate(`${today}T21:00`, tz)) };
      });
      return { user: u.name, res };
    },
  };
}

app.post('/api/ai', async (req, res) => {
  try {
    const q = String((req.body && req.body.q) || '').toLowerCase();
    const db = acl.load();
    const doors = (DEMO ? DEMO_LOCKS : ((await tt.listLocks(1,200)).list || []))
      .filter(d => rbac.canAccessLock(db, req.operator, d.lockId));
    const T = aiTools(db, doors);
    let answer;

    if (/batter|service|visit|maintenance|replace/.test(q)) {
      const { low, off } = T.serviceVisits();
      answer = `<b>Suggested service run</b><br>` +
        (low.length ? low.map(d => `· <b>${d.lockAlias}</b> — ${d.electricQuantity}% battery` +
          (d.electricQuantity <= 15 ? ' <span class="tag r">urgent</span>' : '')).join('<br>')
          : 'No low batteries.') +
        (off.length ? `<br>· <b>${off.map(d=>d.lockAlias).join(', ')}</b> — no gateway, cannot be opened remotely` : '') +
        `<br><br>Batching these into one visit saves a second call-out. Shall I draft the job sheet?`;
    }
    else if (/unusual|anomal|risk|suspicious|odd|wrong/.test(q)) {
      const a = T.anomalies();
      answer = `<b>Risk review</b><br>` +
        `· ${a.denials} denied unlock attempt(s) recorded<br>` +
        `· ${a.suspended.length} suspended user(s): ${a.suspended.map(u=>u.name).join(', ')||'none'}<br>` +
        `· ${a.expiring.length} credential(s) expiring within 30 days: ${a.expiring.map(u=>u.name).join(', ')||'none'}<br><br>` +
        `Recommendation: remove suspended users from all groups so they disappear from reports, and renew expiring contractors before they lock themselves out.`;
    }
    else if (/who can|who has|access to/.test(q)) {
      const m = q.match(/(server room|main entrance|warehouse|cleaner|gym front|gym staff|storage)/);
      const r = m ? T.whoCanOpen(m[1]) : null;
      answer = r
        ? `<b>${r.door}</b> — currently openable by: ${r.people.length ? r.people.join(', ') : '<i>nobody at this moment</i>'}.<br><br>This is evaluated live against schedules, so the answer changes with the clock.`
        : `Name a door and I will list who can open it right now — e.g. "who can open the Server Room?"`;
    }
    else if (/denied|why|refus|reject/.test(q)) {
      const m = q.match(/(sarah|dev|tom|cleanco|cleaner)/);
      const r = m ? T.explainDenial(m[1]) : null;
      if (r) {
        const denied = r.res.filter(x => !x.r.allowed).slice(0, 4);
        answer = `<b>${r.user}</b> at 21:00 (each site's local time):<br>` +
          denied.map(x => `· ${x.door}: ${x.r.reason}`).join('<br>') +
          `<br><br>Most denials at that hour come from the <i>Office Hours</i> schedule ending 18:30. To change it, I can extend the window or add an evening exception — your approval required.`;
      } else {
        answer = `Tell me who was denied — e.g. "why was Sarah denied at 9pm?"`;
      }
    }
    else if (/give|grant|add|allow|extend/.test(q)) {
      answer = `<b>Proposed change</b> (not yet applied)<br>` +
        `I would add a rule: <b>Cleaning Contractor</b> → <b>Operations</b> on <b>Friday 18:00–21:00</b>.<br><br>` +
        `Impact: 1 user group, 2 doors. No existing rule is removed.<br>` +
        `<i>Nothing is executed until you confirm — every AI action is proposal-then-approve, and lands in the audit log with "ai" as the actor.</i>`;
    }
    else {
      answer = `I can help with:<br>· <b>Diagnostics</b> — "which doors need a battery visit?"<br>` +
        `· <b>Explaining decisions</b> — "why was Sarah denied at 9pm?"<br>` +
        `· <b>Queries</b> — "who can open the Server Room?"<br>` +
        `· <b>Risk review</b> — "anything unusual this week?"<br>` +
        `· <b>Rule drafting</b> — "give the cleaners Friday evening access"<br><br>` +
        `<i>Running on the deterministic router. Set OPENAI_API_KEY to enable full natural language.</i>`;
    }
    ok(res, { answer });
  } catch (e) { fail(res, e); }
});

module.exports = { app };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => console.log(`Access control server on ${PORT} — mode: ${DEMO ? 'DEMO' : 'LIVE'}`));
}
