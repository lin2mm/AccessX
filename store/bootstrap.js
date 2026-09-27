/**
 * Tenant seeding and legacy import — shared by server and worker.
 *
 * seedTenant() is idempotent: it does nothing once tenants.seeded = 1.
 * Legacy sources (the pre-SQL JSON state, the old audit chain) are
 * imported ONCE, with their hash chain verified first so history stays
 * provable across the migration.
 */
const auditCore = require('../audit-core');
const rbac = require('../rbac-core');
const policy = require('../policy-core');
const { COLLECTIONS } = require('./repo');
const { ConflictError } = require('./sql');

/**
 * Pre-0003 data has no userGroups[].siteId. Infer it: if every rule for a
 * group points at door groups of ONE site, the group belongs there.
 * Groups spanning sites stay cross-site (all-site operators only).
 */
function inferGroupSites(data) {
  const inferred = [];
  const groups = (data.userGroups || []).map(g => {
    if (g.siteId) return g;
    const sites = new Set((data.assignments || []).filter(a => a.userGroupId === g.id)
      .map(a => ((data.doorGroups || []).find(d => d.id === a.doorGroupId) || {}).siteId).filter(Boolean));
    if (sites.size !== 1) return g;
    const siteId = [...sites][0];
    inferred.push(`${g.id}→${siteId}`);
    return { ...g, siteId };
  });
  return { data: { ...data, userGroups: groups }, inferred };
}

async function seedTenant(store, tenantId, { data, sealedAudit = null, legacyAudit = null, source = 'seed' } = {}) {
  const t = store.tenant(tenantId);
  const info = await t.info();
  if (!info) throw new Error(`tenant ${tenantId} does not exist`);
  if (info.seeded) return { seeded: false };

  const { data: withSites, inferred } = inferGroupSites(data || {});
  data = withSites;
  const uow = t.unit();
  const counts = {};
  for (const collection of Object.keys(COLLECTIONS)) {
    let items = Array.isArray(data && data[collection]) ? data[collection] : [];
    if (collection === 'roles' && !items.length) items = rbac.DEFAULT_ROLES;
    // Legacy JSON records (e.g. holidays) may lack ids; the table requires one.
    items.forEach(item => uow.insert(collection, { ...item, id: item.id || policy.uid(collection.slice(0, 3)) }));
    counts[collection] = items.length;
  }
  uow.raw('UPDATE tenants SET seeded = 1, settings = ? WHERE id = ?', [JSON.stringify((data && data.settings) || {}), tenantId]);

  const head = await t.auditHead();
  if (head.seq === 0) {
    if (sealedAudit && sealedAudit.length) {
      const check = auditCore.verify(sealedAudit);
      if (check.ok) uow.importSealed(sealedAudit);
      else uow.audit('audit.import_rejected', `legacy chain failed verification at #${check.brokenAt}: ${check.problem}`);
    } else if (legacyAudit && legacyAudit.length) {
      auditCore.fromLegacy(legacyAudit).forEach(e => uow.audit(e.action, e.detail, e.actor));
    }
  }
  const summary = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ');
  uow.audit('tenant.seeded', `source=${source} ${summary}`);
  if (inferred.length) uow.audit('userGroups.site_inferred', inferred.join(' '));

  try {
    await uow.commit();
  } catch (error) {
    // Another instance seeded concurrently — fine if it finished.
    if (error instanceof ConflictError && (await t.info()).seeded) return { seeded: false };
    throw error;
  }
  return { seeded: true, counts };
}

/**
 * Put a demo tenant back to its sample data (R15, POST
 * /api/platform/tenants/:id/demo-reset). One transaction. The audit chain is
 * append-only and stays: the reset is one more entry on it. Operators,
 * sessions, settings, billing and roles already present are kept; everything
 * a demo visitor could have typed (people, groups, rules, codes, visitors,
 * approvals, alarms) is replaced. The caller checks that the tenant has no
 * real doors.
 */
const DEMO_RESET_TABLES = ['approvals', 'credentials', 'walkins', 'calendar_drafts', 'visit_invites', 'visits', 'alert_outbox', 'lock_alarms', 'lock_battery', 'lock_health',
  'directory_groups', 'assignments', 'users', 'user_groups', 'door_groups', 'schedules', 'holidays', 'sites'];
async function resetDemoTenant(store, tenantId, { data, actor = 'platform' } = {}) {
  const t = store.tenant(tenantId);
  const snap = await t.snapshot();
  const { data: sample } = inferGroupSites(data || {});
  const haveRoles = new Set((snap.roles || []).map(r => r.id));
  const uow = t.unit();
  for (const table of DEMO_RESET_TABLES) uow.raw(`DELETE FROM ${table} WHERE tenant_id = ?`, [tenantId]);
  const counts = {};
  for (const collection of Object.keys(COLLECTIONS)) {
    let items = Array.isArray(sample[collection]) ? sample[collection] : [];
    if (collection === 'roles') items = (items.length ? items : rbac.DEFAULT_ROLES).filter(r => !haveRoles.has(r.id));
    items.forEach(item => uow.insert(collection, { ...item, id: item.id || policy.uid(collection.slice(0, 3)) }));
    counts[collection] = items.length;
  }
  const summary = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ');
  uow.audit('demo.reset', `sample data restored: ${summary}`, actor);
  await uow.commit();
  return counts;
}

module.exports = { resetDemoTenant, DEMO_RESET_TABLES, seedTenant, inferGroupSites };
