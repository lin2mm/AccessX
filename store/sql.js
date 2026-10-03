/**
 * Minimal async SQL interface over Cloudflare D1 and Node's node:sqlite.
 *   all(sql, params)   -> rows
 *   first(sql, params) -> row | null
 *   batch([{ sql, params }]) -> runs atomically (one transaction)
 * Both engines speak SQLite, so migrations/*.sql serve both.
 * Node's adapter lives in sqlite-node.js so the Worker bundle never
 * references node:sqlite.
 */

class ConflictError extends Error {
  constructor(message) { super(message); this.name = 'ConflictError'; this.status = 409; }
}

const isConstraint = error => /constraint|UNIQUE|PRIMARY KEY/i.test(String(error && error.message));

/**
 * `meter` (optional, R20): { queries, rowsRead, rowsWritten } summed from D1's
 * per-query `meta` (what Cloudflare bills). Off in production unless USAGE_METER=1.
 */
function d1Adapter(d1, { meter = null } = {}) {
  const prep = ({ sql, params = [] }) => d1.prepare(sql).bind(...params);
  const count = r => {
    if (meter && r) {
      const m = r.meta || {};
      meter.queries += 1; meter.rowsRead += Number(m.rows_read) || 0; meter.rowsWritten += Number(m.rows_written) || 0;
    }
    return r;
  };
  return {
    kind: 'd1',
    meter,
    async all(sql, params = []) { return count(await prep({ sql, params }).all()).results || []; },
    async first(sql, params = []) {
      // first() carries no meta; the same statement through all() does (D1 runs it the same way).
      if (meter) return (count(await prep({ sql, params }).all()).results || [])[0] || null;
      return (await prep({ sql, params }).first()) || null;
    },
    async batch(statements) {
      if (!statements.length) return;
      try {
        const results = await d1.batch(statements.map(prep));
        if (meter) for (const r of results || []) count(r);
      } catch (error) {
        if (isConstraint(error)) throw new ConflictError(error.message);
        throw error;
      }
    },
  };
}

module.exports = { d1Adapter, ConflictError, isConstraint };
