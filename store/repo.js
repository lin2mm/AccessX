/**
 * Tenant-scoped repository over the SQL adapter.
 * ====================================================================
 * The ONLY way to touch business data is store.tenant(id): every
 * statement it builds includes tenant_id. There is no un-scoped query
 * helper to misuse.
 *
 *   const t = store.tenant('t_default');
 *   const snap = await t.snapshot();          // shape the policy engine expects
 *   const uow = t.unit();                     // unit of work
 *   uow.insert('users', { id, name, ... });
 *   uow.audit('users.create', 'u_1', actor);
 *   await uow.commit();                       // audit + rows in ONE transaction
 *
 * Writes are row-level (no more read-modify-write of one JSON blob), so
 * two operators editing different records can no longer overwrite each
 * other.
 */
const auditCore = require('../audit-core');
const { ConflictError } = require('./sql');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const j = { json: true };
const b = { bool: true };
const i = { int: true };
const COLLECTIONS = {
  sites: { table: 'sites', fields: { name: 'name', address: 'address', timezone: 'timezone' } },
  doorGroups: { table: 'door_groups', fields: { siteId: 'site_id', name: 'name', lockIds: ['lock_ids', j] } },
  userGroups: { table: 'user_groups', fields: { name: 'name', siteId: 'site_id' } },
  users: {
    table: 'users',
    fields: {
      name: 'name', email: 'email', groupIds: ['group_ids', j], suspended: ['suspended', b],
      validFrom: 'valid_from', validTo: 'valid_to',
    },
  },
  schedules: {
    table: 'schedules',
    fields: {
      name: 'name', denyOnHolidays: ['deny_on_holidays', b], windows: ['windows', j],
      validFrom: 'valid_from', validTo: 'valid_to',
    },
  },
  assignments: { table: 'assignments', fields: { userGroupId: 'user_group_id', doorGroupId: 'door_group_id', scheduleId: 'schedule_id' } },
  holidays: { table: 'holidays', fields: { date: 'date', name: 'name', siteId: 'site_id' } },
  roles: { table: 'roles', fields: { name: 'name', perms: ['perms', j] } },
  credentials: {
    table: 'credentials',
    fields: {
      type: 'type', userId: 'user_id', lockId: ['lock_id', i], siteId: 'site_id', startAt: 'start_at', endAt: 'end_at',
      enforcement: 'enforcement', rules: ['rules', j], status: 'status', vendorRef: 'vendor_ref', codeHint: 'code_hint',
      issuedBy: 'issued_by', issuedAt: 'issued_at', revokedAt: 'revoked_at', revokedBy: 'revoked_by', revokeReason: 'revoke_reason',
    },
  },
};

const spec = field => (Array.isArray(field) ? { col: field[0], ...field[1] } : { col: field });

function toRow(collection, item) {
  const out = {};
  for (const [key, field] of Object.entries(COLLECTIONS[collection].fields)) {
    if (!(key in item)) continue;
    const { col, json, bool, int } = spec(field);
    let v = item[key];
    if (v === undefined) continue;
    if (json) v = JSON.stringify(v ?? []);
    else if (bool) v = v ? 1 : 0;
    else if (int) v = v === null ? null : Number(v);
    else if (v !== null) v = String(v);
    out[col] = v;
  }
  return out;
}

function fromRow(collection, row) {
  const item = { id: row.id };
  for (const [key, field] of Object.entries(COLLECTIONS[collection].fields)) {
    const { col, json, bool, int } = spec(field);
    const v = row[col];
    if (v === null || v === undefined) {
      if (json) item[key] = [];
      else if (bool) item[key] = false;
      continue;
    }
    item[key] = json ? JSON.parse(v) : bool ? Boolean(v) : int ? Number(v) : v;
  }
  return item;
}

const rowToAudit = row => ({
  seq: row.seq, id: row.id, ts: row.ts, actor: row.actor, action: row.action,
  detail: row.detail, prevHash: row.prev_hash, hash: row.hash,
});

function createStore(sql) {
  function tenant(tenantId) {
    if (!tenantId || typeof tenantId !== 'string') throw new Error('tenant id required');

    async function snapshot() {
      const names = Object.keys(COLLECTIONS);
      const results = await Promise.all(names.map(name =>
        sql.all(`SELECT * FROM ${COLLECTIONS[name].table} WHERE tenant_id = ? ORDER BY rowid`, [tenantId])));
      const snap = {};
      names.forEach((name, index) => { snap[name] = results[index].map(row => fromRow(name, row)); });
      const t = await sql.first('SELECT name, settings FROM tenants WHERE id = ?', [tenantId]);
      snap.settings = t ? JSON.parse(t.settings || '{}') : {};
      snap.tenant = { id: tenantId, name: t ? t.name : tenantId };
      return snap;
    }

    async function auditHead() {
      const row = await sql.first('SELECT seq, hash FROM audit_events WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1', [tenantId]);
      return row ? { seq: row.seq, hash: row.hash } : { seq: 0, hash: auditCore.GENESIS };
    }

    function unit() {
      const statements = [];
      const pending = [];
      const sealedImports = [];
      const api = {
        insert(collection, item) {
          if (!COLLECTIONS[collection]) throw new Error(`unknown collection ${collection}`);
          if (!item.id) throw new Error(`${collection} insert without id`);
          const row = { tenant_id: tenantId, id: item.id, ...toRow(collection, item) };
          const cols = Object.keys(row);
          statements.push({
            sql: `INSERT INTO ${COLLECTIONS[collection].table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            params: cols.map(c => row[c]),
          });
          return api;
        },
        update(collection, id, patch) {
          const row = toRow(collection, patch);
          const cols = Object.keys(row);
          if (!cols.length) return api;
          statements.push({
            sql: `UPDATE ${COLLECTIONS[collection].table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`,
            params: [...cols.map(c => row[c]), tenantId, id],
          });
          return api;
        },
        remove(collection, id) {
          statements.push({ sql: `DELETE FROM ${COLLECTIONS[collection].table} WHERE tenant_id = ? AND id = ?`, params: [tenantId, id] });
          return api;
        },
        raw(sqlText, params) { statements.push({ sql: sqlText, params }); return api; },
        audit(action, detail, actor = 'system') { pending.push(auditCore.pending(action, detail, actor)); return api; },
        importSealed(entries) { sealedImports.push(...entries); return api; },
        get size() { return statements.length + pending.length + sealedImports.length; },
        /**
         * Seal audit entries onto the current head and run everything in
         * one transaction. If another writer took the same seq first, the
         * PK rejects the batch; re-seal on the new head and retry.
         */
        async commit({ retries = 12 } = {}) {
          for (let attempt = 0; ; attempt++) {
            const lastImport = sealedImports[sealedImports.length - 1];
            const head = lastImport ? { seq: lastImport.seq, hash: lastImport.hash } : await auditHead();
            const sealed = auditCore.seal(head, pending);
            const auditStatements = [...sealedImports, ...sealed].map(e => ({
              sql: 'INSERT INTO audit_events (tenant_id, seq, id, ts, actor, action, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              params: [tenantId, e.seq, e.id, e.ts, e.actor, e.action, e.detail, e.prevHash, e.hash],
            }));
            try {
              // audit first inside the transaction (write-ahead ordering)
              await sql.batch([...auditStatements, ...statements]);
              return sealed;
            } catch (error) {
              if (!(error instanceof ConflictError) || attempt >= retries || sealedImports.length) throw error;
              // Full-jitter exponential backoff: colliding writers spread out
              // instead of re-colliding in lockstep.
              await sleep(Math.random() * Math.min(1000, 8 * 2 ** attempt));
            }
          }
        },
      };
      return api;
    }

    async function auditRecent({ limit = 100, before = null, action = null, actor = null } = {}) {
      const where = ['tenant_id = ?'];
      const params = [tenantId];
      if (before) { where.push('seq < ?'); params.push(before); }
      if (action) { where.push('action = ?'); params.push(action); }
      if (actor) { where.push('actor = ?'); params.push(actor); }
      params.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
      const rows = await sql.all(`SELECT * FROM audit_events WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`, params);
      return rows.map(rowToAudit);
    }

    async function auditCount(action) {
      const row = await sql.first('SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND action = ?', [tenantId, action]);
      return row ? Number(row.n) : 0;
    }

    async function auditVerify() {
      const rows = await sql.all('SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY seq ASC', [tenantId]);
      return auditCore.verify(rows.map(rowToAudit));
    }

    async function operators() {
      const rows = await sql.all('SELECT id, name, role, site_ids, created_by, created_at, revoked_at FROM operators WHERE tenant_id = ? ORDER BY created_at', [tenantId]);
      return rows.map(r => ({
        id: r.id, name: r.name, role: r.role, siteIds: r.site_ids ? JSON.parse(r.site_ids) : undefined,
        createdBy: r.created_by, createdAt: r.created_at, revokedAt: r.revoked_at,
      }));
    }

    async function info() {
      return sql.first('SELECT id, name, seeded, settings FROM tenants WHERE id = ?', [tenantId]);
    }

    return { id: tenantId, snapshot, unit, auditRecent, auditCount, auditVerify, auditHead, operators, info };
  }

  /** Token hash → operator (any tenant). Revoked operators never match. */
  async function operatorByTokenHash(hash) {
    const r = await sql.first('SELECT tenant_id, id, name, role, site_ids FROM operators WHERE token_sha256 = ? AND revoked_at IS NULL', [hash]);
    return r ? { tenantId: r.tenant_id, id: r.id, name: r.name, role: r.role, siteIds: r.site_ids ? JSON.parse(r.site_ids) : undefined } : null;
  }

  async function createTenant(id, name) {
    await sql.batch([{ sql: 'INSERT INTO tenants (id, name, seeded) VALUES (?, ?, 0)', params: [id, name] }]);
    return tenant(id);
  }

  async function listTenants() {
    return sql.all('SELECT id, name, seeded, created_at FROM tenants ORDER BY created_at');
  }

  return { sql, tenant, operatorByTokenHash, createTenant, listTenants, COLLECTIONS };
}

/** Rows for an operator insert (token already hashed). */
function operatorStatement(tenantId, op) {
  return {
    sql: 'INSERT INTO operators (tenant_id, id, name, role, site_ids, token_sha256, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [tenantId, op.id, op.name, op.role, op.siteIds && op.siteIds.length ? JSON.stringify(op.siteIds) : null, op.tokenSha256, op.createdBy || null],
  };
}

module.exports = { createStore, operatorStatement, COLLECTIONS, toRow, fromRow };
