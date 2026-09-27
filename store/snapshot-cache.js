/**
 * Per-process tenant snapshot cache.
 * ====================================================================
 * Without it every request re-reads the whole tenant (ten tables): ~220 ms
 * and ~20k D1 rows read per request at 10k people, and a SCIM burst is
 * capped at a few writes per second because each write re-reads everything.
 *
 * Correctness does not depend on callers remembering to invalidate:
 *   - migrations/0011 adds SQLite triggers on every snapshot table. ANY
 *     insert/update/delete (any code path, manual SQL included) bumps
 *     tenants.data_version and logs (version, table, row id).
 *   - snapshot() reads data_version with the tenant row it needs anyway.
 *     Same version → cached collections, zero table reads.
 *     Newer version → refetch only the logged rows and patch (copy-on-write).
 *     Gap in the log (pruned, restored database), many changes, or an entry
 *     older than maxAgeMs → full reload.
 *   - The version is read BEFORE the data, so cached data is never older
 *     than its label; patches are idempotent (they apply current row state).
 *   - One refresh per tenant at a time, so concurrent patches cannot interleave.
 *
 * Cached items are shared between requests, so they are deep-frozen and every
 * caller gets its own arrays. The modules are sloppy-mode, where writing to a
 * frozen object fails silently — so tests run in guard mode, where items are
 * proxies that THROW on any write, surfacing code that treats a snapshot as
 * scratch space.
 *
 * Each process (Node server, every Worker isolate, every Durable Object) has
 * its own cache; they never need to talk to each other because the database
 * version is checked on every read.
 */
const ID_CHUNK = 90; // D1 allows 100 bound parameters per statement (tenant_id + 90 ids)

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

class SnapshotMutationError extends TypeError {
  constructor(what) {
    super(`snapshot data is shared between requests and read-only (tried to ${what}); copy it first ({ ...item }, arr.slice())`);
    this.name = 'SnapshotMutationError';
  }
}

function createGuard() {
  const proxies = new WeakMap();
  const handler = {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      return v && typeof v === 'object' ? wrap(v) : v;
    },
    set(target, key) { throw new SnapshotMutationError(`set ${String(key)}`); },
    deleteProperty(target, key) { throw new SnapshotMutationError(`delete ${String(key)}`); },
    defineProperty(target, key) { throw new SnapshotMutationError(`define ${String(key)}`); },
    setPrototypeOf() { throw new SnapshotMutationError('change the prototype'); },
    preventExtensions() { throw new SnapshotMutationError('freeze/seal it'); },
  };
  function wrap(obj) {
    let p = proxies.get(obj);
    if (!p) { p = new Proxy(obj, handler); proxies.set(obj, p); }
    return p;
  }
  return wrap;
}

/**
 * @param {object} o
 * @param {object} o.sql            adapter (all/first)
 * @param {object} o.collections    repo COLLECTIONS
 * @param {(name:string,row:object)=>object} o.toItem  row → snapshot item (fromRow + derived fields)
 * @param {number} [o.maxRows]      memory budget in cached rows across tenants (0 = cache off)
 * @param {number} [o.patchMax]     more changes than this → full reload
 * @param {number} [o.maxAgeMs]     full reload after this, whatever the version says
 * @param {boolean} [o.guard]       throw on writes to snapshot items (tests)
 */
function createSnapshotCache({ sql, collections, toItem, maxRows = 500000, patchMax = 2000, maxAgeMs = 15 * 60 * 1000, guard = false, now = () => Date.now() }) {
  const names = Object.keys(collections);
  const nameOfTable = Object.fromEntries(names.map(n => [collections[n].table, n]));
  const entries = new Map(); // tenantId -> entry (Map order = LRU order)
  const inflight = new Map(); // tenantId -> Promise<entry>
  const stats = { hits: 0, patches: 0, patchedRows: 0, loads: 0, evictions: 0, restores: 0 };
  const wrap = guard ? createGuard() : null;
  const prepare = (name, row) => { const item = toItem(name, row); return guard ? item : deepFreeze(item); };

  function build(name, rows) {
    const items = new Array(rows.length);
    const rowids = new Array(rows.length);
    const pos = new Map();
    rows.forEach((row, i) => { items[i] = prepare(name, row); rowids[i] = Number(row.__rowid); pos.set(String(row.id), i); });
    return { items, rowids, pos };
  }

  async function load(tenantId, version) {
    stats.loads++;
    const results = await Promise.all(names.map(n =>
      sql.all(`SELECT rowid AS __rowid, * FROM ${collections[n].table} WHERE tenant_id = ? ORDER BY rowid`, [tenantId])));
    const cols = {};
    let rows = 0;
    names.forEach((n, i) => { cols[n] = build(n, results[i]); rows += results[i].length; });
    return { version, cols, rows, loadedAt: now() };
  }

  /** Replace/insert/delete the given ids in one collection; returns a new struct (old one untouched). */
  function apply(name, struct, ids, fetched) {
    let items = struct.items;
    let copied = false;
    const removed = new Set();
    const inserts = [];
    for (const id of ids) {
      const i = struct.pos.get(id);
      const row = fetched.get(id);
      if (!row) { if (i !== undefined) removed.add(i); continue; }
      const item = prepare(name, row);
      const rowid = Number(row.__rowid);
      if (i !== undefined && struct.rowids[i] === rowid) {
        if (!copied) { items = items.slice(); copied = true; }
        items[i] = item;
      } else {
        if (i !== undefined) removed.add(i);
        inserts.push({ rowid, item, id });
      }
    }
    if (!removed.size && !inserts.length) return { items, rowids: struct.rowids, pos: struct.pos };
    // Rebuild in rowid order (what a full load's ORDER BY rowid would give).
    inserts.sort((a, b) => a.rowid - b.rowid);
    const outItems = [];
    const outRowids = [];
    let k = 0;
    for (let i = 0; i < items.length; i++) {
      if (removed.has(i)) continue;
      while (k < inserts.length && inserts[k].rowid < struct.rowids[i]) { outItems.push(inserts[k].item); outRowids.push(inserts[k].rowid); k++; }
      outItems.push(items[i]); outRowids.push(struct.rowids[i]);
    }
    for (; k < inserts.length; k++) { outItems.push(inserts[k].item); outRowids.push(inserts[k].rowid); }
    const pos = new Map();
    outItems.forEach((item, i) => pos.set(String(item.id), i));
    return { items: outItems, rowids: outRowids, pos };
  }

  async function patch(tenantId, entry) {
    const changes = await sql.all('SELECT version, tbl, row_id FROM snapshot_changes WHERE tenant_id = ? AND version > ? ORDER BY version LIMIT ?',
      [tenantId, entry.version, patchMax + 1]);
    if (!changes.length || changes.length > patchMax) return null;
    // Versions are consecutive per tenant; a hole means the log was pruned past us.
    for (let i = 0; i < changes.length; i++) if (Number(changes[i].version) !== entry.version + 1 + i) return null;
    const byName = new Map();
    for (const c of changes) {
      const name = nameOfTable[c.tbl];
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(String(c.row_id));
    }
    const cols = { ...entry.cols };
    let rows = entry.rows;
    for (const [name, idSet] of byName) {
      const ids = [...idSet];
      const fetched = new Map();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        const got = await sql.all(`SELECT rowid AS __rowid, * FROM ${collections[name].table} WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`, [tenantId, ...chunk]);
        for (const row of got) fetched.set(String(row.id), row);
      }
      const before = cols[name].items.length;
      cols[name] = apply(name, cols[name], ids, fetched);
      rows += cols[name].items.length - before;
    }
    stats.patches++;
    stats.patchedRows += changes.length;
    return { version: Number(changes[changes.length - 1].version), cols, rows, loadedAt: entry.loadedAt };
  }

  function remember(tenantId, entry) {
    entries.delete(tenantId);
    if (entry.rows > maxRows) return entry; // bigger than the whole budget: serve, don't keep
    entries.set(tenantId, entry);
    let total = 0;
    for (const e of entries.values()) total += e.rows;
    for (const [id, e] of entries) {
      if (total <= maxRows || id === tenantId) break;
      entries.delete(id); total -= e.rows; stats.evictions++;
    }
    return entry;
  }

  async function refresh(tenantId, version) {
    const entry = entries.get(tenantId);
    if (entry && version > entry.version && version - entry.version <= patchMax && now() - entry.loadedAt < maxAgeMs) {
      const next = await patch(tenantId, entry);
      if (next) return remember(tenantId, next);
    }
    return remember(tenantId, await load(tenantId, version));
  }

  /** Collections for this tenant at (at least) `version`. version === null → uncached read. */
  async function read(tenantId, version) {
    if (version === null || maxRows <= 0) return (await load(tenantId, null)).cols;
    let waited = false;
    for (;;) {
      const e = entries.get(tenantId);
      if (e && e.version >= version && now() - e.loadedAt < maxAgeMs) {
        // Newer than what we read: normally another request refreshed after our
        // version read (serve it, it is fresher). But a restored database also
        // moves the version backwards — then the cached version's change row is
        // gone. One PK lookup, only on this path.
        if (e.version > version && !waited) {
          const still = await sql.first('SELECT 1 AS ok FROM snapshot_changes WHERE tenant_id = ? AND version = ?', [tenantId, e.version]);
          if (!still) { if (entries.get(tenantId) === e) entries.delete(tenantId); stats.restores++; continue; }
        }
        stats.hits++;
        entries.delete(tenantId); entries.set(tenantId, e); // LRU touch
        return e.cols;
      }
      const running = inflight.get(tenantId);
      if (!running) break;
      await running.catch(() => {});
      waited = true;
    }
    const p = refresh(tenantId, version);
    inflight.set(tenantId, p);
    try {
      return (await p).cols;
    } finally {
      if (inflight.get(tenantId) === p) inflight.delete(tenantId);
    }
  }

  /** What callers get: their own arrays over shared (frozen or guarded) items. */
  function view(struct) {
    return guard ? struct.items.map(wrap) : struct.items.slice();
  }

  return {
    read,
    view,
    clear(tenantId) { if (tenantId) entries.delete(tenantId); else entries.clear(); },
    stats: () => ({ ...stats, tenants: entries.size, rows: [...entries.values()].reduce((n, e) => n + e.rows, 0), maxRows, guard }),
  };
}

module.exports = { createSnapshotCache, deepFreeze, SnapshotMutationError };
