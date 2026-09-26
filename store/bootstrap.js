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

async function seedTenant(store, tenantId, { data, sealedAudit = null, legacyAudit = null, source = 'seed' } = {}) {
  const t = store.tenant(tenantId);
  const info = await t.info();
  if (!info) throw new Error(`tenant ${tenantId} does not exist`);
  if (info.seeded) return { seeded: false };

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

  try {
    await uow.commit();
  } catch (error) {
    // Another instance seeded concurrently — fine if it finished.
    if (error instanceof ConflictError && (await t.info()).seeded) return { seeded: false };
    throw error;
  }
  return { seeded: true, counts };
}

module.exports = { seedTenant };
