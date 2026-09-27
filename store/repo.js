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
const { createSnapshotCache } = require('./snapshot-cache');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const j = { json: true };
const b = { bool: true };
const i = { int: true };
const COLLECTIONS = {
  sites: { table: 'sites', fields: { name: 'name', address: 'address', timezone: 'timezone' } },
  doorGroups: { table: 'door_groups', fields: { siteId: 'site_id', name: 'name', lockIds: ['lock_ids', j], sensitive: ['sensitive', b] } },
  userGroups: { table: 'user_groups', fields: { name: 'name', siteId: 'site_id' } },
  users: {
    table: 'users',
    fields: {
      name: 'name', email: 'email', groupIds: ['group_ids', j], suspended: ['suspended', b],
      validFrom: 'valid_from', validTo: 'valid_to',
      // directory provisioning (server-managed, never client-writable)
      source: 'source', externalId: 'external_id', userName: 'user_name',
      // 'active' | 'inactive' | null. Kept apart from `suspended` (the
      // operator's switch) so a routine directory sync can never undo an
      // operator's emergency suspension, and vice versa.
      directoryStatus: 'directory_status',
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
  directoryGroups: {
    table: 'directory_groups',
    fields: { externalId: 'external_id', displayName: 'display_name', userGroupId: 'user_group_id', memberIds: ['member_ids', j] },
  },
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

/** Snapshot item for a row, including derived fields. */
function toSnapshotItem(name, row) {
  const item = fromRow(name, row);
  if (name !== 'users') return item;
  // Effective suspension = operator switch OR directory deactivation.
  if (item.directoryStatus !== 'inactive') return item.suspended ? { ...item, suspendedBy: 'operator' } : item;
  return { ...item, suspended: true, suspendedBy: item.suspended ? 'operator+directory' : 'directory' };
}

const envFlag = name => (typeof process !== 'undefined' && process.env ? process.env[name] : undefined);

/**
 * @param sql adapter
 * @param {object} [options]
 * @param {object} [options.snapshotCache] { maxRows, patchMax, maxAgeMs, guard } — see snapshot-cache.js.
 *   maxRows 0 turns the cache off. guard defaults to ACCESSX_SNAPSHOT_GUARD=1 (tests).
 */
function createStore(sql, { snapshotCache = {} } = {}) {
  const cache = createSnapshotCache({
    sql, collections: COLLECTIONS, toItem: toSnapshotItem,
    guard: envFlag('ACCESSX_SNAPSHOT_GUARD') === '1',
    ...snapshotCache,
  });
  // false once we learn the database predates migration 0011 (deploy before
  // migrate): keep serving, uncached, instead of failing every request.
  let versioned = true;

  async function tenantRow(tenantId) {
    if (versioned) {
      try {
        return await sql.first('SELECT name, settings, data_version FROM tenants WHERE id = ?', [tenantId]);
      } catch (error) {
        if (!/no such column|data_version/i.test(String(error && error.message))) throw error;
        versioned = false;
      }
    }
    return sql.first('SELECT name, settings FROM tenants WHERE id = ?', [tenantId]);
  }

  function tenant(tenantId) {
    if (!tenantId || typeof tenantId !== 'string') throw new Error('tenant id required');

    async function snapshot() {
      // Version BEFORE data: cached data is never older than its label.
      const t = await tenantRow(tenantId);
      const version = t && t.data_version !== undefined && t.data_version !== null ? Number(t.data_version) : null;
      const cols = await cache.read(tenantId, version);
      const snap = {};
      for (const name of Object.keys(COLLECTIONS)) snap[name] = cache.view(cols[name]);
      snap.settings = t ? JSON.parse(t.settings || '{}') : {};
      snap.tenant = { id: tenantId, name: t ? t.name : tenantId };
      return snap;
    }

    /** Keep the newest `keep` change-log rows (maintenance). Older caches just reload in full. */
    async function pruneChanges(keep = 5000) {
      if (!versioned) return 0;
      const row = await sql.first('SELECT data_version AS v FROM tenants WHERE id = ?', [tenantId]);
      const cutoff = row ? Number(row.v) - keep : 0;
      if (cutoff <= 0) return 0;
      const n = await sql.first('SELECT COUNT(*) AS n FROM snapshot_changes WHERE tenant_id = ? AND version <= ?', [tenantId, cutoff]);
      if (!n || !Number(n.n)) return 0;
      await sql.batch([{ sql: 'DELETE FROM snapshot_changes WHERE tenant_id = ? AND version <= ?', params: [tenantId, cutoff] }]);
      return Number(n.n);
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
        async commit({ retries = 12, expectHead = null } = {}) {
          for (let attempt = 0; ; attempt++) {
            const lastImport = sealedImports[sealedImports.length - 1];
            const head = lastImport ? { seq: lastImport.seq, hash: lastImport.hash } : expectHead || await auditHead();
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
              // expectHead = compare-and-swap: the caller computed these writes
              // from state at that head, so re-sealing on a newer head would
              // silently overwrite someone else's change. Let transact() redo it.
              if (!(error instanceof ConflictError) || attempt >= retries || sealedImports.length || expectHead) throw error;
              // Full-jitter exponential backoff: colliding writers spread out
              // instead of re-colliding in lockstep.
              await sleep(Math.random() * Math.min(1000, 8 * 2 ** attempt));
            }
          }
        },
      };
      return api;
    }

    /**
     * Optimistic read-modify-write. `fn(snapshot, uow)` must be pure apart
     * from queueing writes (no vendor calls). Every write carries an audit
     * entry, so the audit head works as the tenant's version number: if
     * anyone committed after we read, the commit conflicts and fn re-runs
     * on fresh state. Lost updates (two SCIM PATCHes on one group) become
     * impossible without per-row version columns.
     */
    async function transact(fn, { retries = 10 } = {}) {
      for (let attempt = 0; ; attempt++) {
        const head = await auditHead(); // read the version BEFORE the data
        const snap = await snapshot();
        const uow = unit();
        const result = await fn(snap, uow);
        if (!uow.size) return result;
        try {
          await uow.commit({ expectHead: head });
          return result;
        } catch (error) {
          if (!(error instanceof ConflictError) || attempt >= retries) throw error;
          await sleep(Math.random() * Math.min(1000, 8 * 2 ** attempt));
        }
      }
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

    /** Latest retention checkpoint (entries up to it were purged), or null. */
    async function auditCheckpoint() {
      const r = await sql.first('SELECT seq, hash, created_at, anchor_seq FROM audit_checkpoints WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1', [tenantId]);
      return r ? { seq: r.seq, hash: r.hash, createdAt: r.created_at, anchorSeq: r.anchor_seq } : null;
    }

    async function auditVerify() {
      const cp = await auditCheckpoint();
      const rows = await sql.all('SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY seq ASC', [tenantId]);
      return auditCore.verify(rows.map(rowToAudit), cp);
    }

    /** Oldest-first slice of the chain, for export. */
    async function auditRange({ fromSeq = 0, toSeq = null, limit = 5000 } = {}) {
      const params = [tenantId, Number(fromSeq) || 0];
      let where = 'tenant_id = ? AND seq >= ?';
      if (toSeq) { where += ' AND seq <= ?'; params.push(Number(toSeq)); }
      params.push(Math.min(Math.max(Number(limit) || 5000, 1), 10000));
      return (await sql.all(`SELECT * FROM audit_events WHERE ${where} ORDER BY seq ASC LIMIT ?`, params)).map(rowToAudit);
    }

    async function auditEntry(seq) {
      const r = await sql.first('SELECT * FROM audit_events WHERE tenant_id = ? AND seq = ?', [tenantId, Number(seq)]);
      return r ? rowToAudit(r) : null;
    }

    async function anchors({ limit = 100, fromSeq = null, toSeq = null } = {}) {
      const params = [tenantId];
      let where = 'tenant_id = ?';
      if (fromSeq !== null) { where += ' AND seq >= ?'; params.push(Number(fromSeq)); }
      if (toSeq !== null) { where += ' AND seq <= ?'; params.push(Number(toSeq)); }
      params.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
      const rows = await sql.all(`SELECT * FROM audit_anchors WHERE ${where} ORDER BY seq DESC LIMIT ?`, params);
      return rows.map(r => ({ seq: r.seq, hash: r.hash, createdAt: r.created_at, keyId: r.key_id, signature: r.signature, deliveredTo: r.delivered_to, deliveryStatus: r.delivery_status }));
    }

    async function operators() {
      const rows = await sql.all('SELECT id, name, role, site_ids, email, sso_subject, break_glass, last_login_at, created_by, created_at, revoked_at FROM operators WHERE tenant_id = ? ORDER BY created_at', [tenantId]);
      return rows.map(r => ({
        id: r.id, name: r.name, role: r.role, siteIds: r.site_ids ? JSON.parse(r.site_ids) : undefined,
        email: r.email || undefined, ssoLinked: Boolean(r.sso_subject), breakGlass: Boolean(r.break_glass), lastLoginAt: r.last_login_at,
        createdBy: r.created_by, createdAt: r.created_at, revokedAt: r.revoked_at,
      }));
    }

    async function info() {
      return sql.first('SELECT id, name, seeded, settings FROM tenants WHERE id = ?', [tenantId]);
    }

    return { id: tenantId, snapshot, pruneChanges, unit, transact, auditRecent, auditCount, auditVerify, auditHead, auditCheckpoint, auditRange, auditEntry, anchors, operators, info };
  }

  const OP_COLS = 'tenant_id, id, name, role, site_ids, email, sso_issuer, sso_subject, break_glass';
  const toOperator = r => (r ? {
    tenantId: r.tenant_id, id: r.id, name: r.name, role: r.role, siteIds: r.site_ids ? JSON.parse(r.site_ids) : undefined,
    email: r.email || undefined, ssoIssuer: r.sso_issuer || undefined, ssoSubject: r.sso_subject || undefined, breakGlass: Boolean(r.break_glass),
  } : null);

  /** Token hash → operator (any tenant). Revoked operators never match. */
  async function operatorByTokenHash(hash) {
    return toOperator(await sql.first(`SELECT ${OP_COLS} FROM operators WHERE token_sha256 = ? AND revoked_at IS NULL`, [hash]));
  }
  async function operatorById(tenantId, id) {
    return toOperator(await sql.first(`SELECT ${OP_COLS} FROM operators WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`, [tenantId, id]));
  }
  async function operatorBySso(issuer, subject) {
    return toOperator(await sql.first(`SELECT ${OP_COLS} FROM operators WHERE sso_issuer = ? AND sso_subject = ? AND revoked_at IS NULL`, [issuer, subject]));
  }
  /** Invited (not yet linked) operator in one tenant, by email (case-insensitive). */
  async function operatorInvite(tenantId, email) {
    return toOperator(await sql.first(`SELECT ${OP_COLS} FROM operators WHERE tenant_id = ? AND lower(email) = lower(?) AND sso_subject IS NULL AND revoked_at IS NULL`, [tenantId, email]));
  }

  /* ---- browser sessions (only the SHA-256 of the cookie value is stored) ---- */
  async function createSession(s) {
    await sql.batch([{
      sql: 'INSERT INTO sessions (id_sha256, tenant_id, operator_id, via, csrf, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [s.idSha256, s.tenantId, s.operatorId, s.via, s.csrf, s.createdAt, s.createdAt, s.expiresAt],
    }]);
  }
  async function findSession(idSha256) {
    const r = await sql.first('SELECT * FROM sessions WHERE id_sha256 = ? AND revoked_at IS NULL', [idSha256]);
    return r ? { idSha256: r.id_sha256, tenantId: r.tenant_id, operatorId: r.operator_id, via: r.via, csrf: r.csrf, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at } : null;
  }
  async function touchSession(idSha256, at) {
    await sql.batch([{ sql: 'UPDATE sessions SET last_seen_at = ? WHERE id_sha256 = ?', params: [at, idSha256] }]);
  }
  async function revokeSession(idSha256, at = new Date().toISOString()) {
    await sql.batch([{ sql: 'UPDATE sessions SET revoked_at = ? WHERE id_sha256 = ? AND revoked_at IS NULL', params: [at, idSha256] }]);
  }

  /* ---- in-flight OIDC logins ---- */
  async function saveFlow(f) {
    await sql.batch([
      { sql: 'DELETE FROM auth_flows WHERE expires_at < ?', params: [new Date().toISOString()] }, // housekeeping
      { sql: 'INSERT INTO auth_flows (state, tenant_id, nonce, code_verifier, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?)', params: [f.state, f.tenantId, f.nonce, f.codeVerifier, f.redirectUri, f.expiresAt] },
    ]);
  }
  /** Read-and-delete: a state can be used exactly once. */
  async function takeFlow(state) {
    const r = await sql.first('SELECT * FROM auth_flows WHERE state = ?', [state]);
    if (!r) return null;
    await sql.batch([{ sql: 'DELETE FROM auth_flows WHERE state = ?', params: [state] }]);
    if (r.expires_at < new Date().toISOString()) return null;
    return { state: r.state, tenantId: r.tenant_id, nonce: r.nonce, codeVerifier: r.code_verifier, redirectUri: r.redirect_uri };
  }

  async function createTenant(id, name) {
    await sql.batch([{ sql: 'INSERT INTO tenants (id, name, seeded) VALUES (?, ?, 0)', params: [id, name] }]);
    return tenant(id);
  }

  async function listTenants() {
    return sql.all('SELECT id, name, seeded, created_at FROM tenants ORDER BY created_at');
  }

  async function tenantSettings(tenantId) {
    const r = await sql.first('SELECT settings FROM tenants WHERE id = ?', [tenantId]);
    return r ? JSON.parse(r.settings || '{}') : null;
  }

  return {
    sql, tenant, createTenant, listTenants, tenantSettings, COLLECTIONS, cacheStats: cache.stats,
    operatorByTokenHash, operatorById, operatorBySso, operatorInvite,
    createSession, findSession, touchSession, revokeSession, saveFlow, takeFlow,
  };
}

/** Rows for an operator insert (token already hashed). */
function operatorStatement(tenantId, op) {
  return {
    sql: 'INSERT INTO operators (tenant_id, id, name, role, site_ids, token_sha256, email, created_by, break_glass) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [tenantId, op.id, op.name, op.role, op.siteIds && op.siteIds.length ? JSON.stringify(op.siteIds) : null, op.tokenSha256, op.email || null, op.createdBy || null, op.breakGlass ? 1 : 0],
  };
}

module.exports = { createStore, operatorStatement, COLLECTIONS, toRow, fromRow };
