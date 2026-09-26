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

function d1Adapter(d1) {
  const prep = ({ sql, params = [] }) => d1.prepare(sql).bind(...params);
  return {
    kind: 'd1',
    async all(sql, params = []) { return (await prep({ sql, params }).all()).results || []; },
    async first(sql, params = []) { return (await prep({ sql, params }).first()) || null; },
    async batch(statements) {
      if (!statements.length) return;
      try {
        await d1.batch(statements.map(prep));
      } catch (error) {
        if (isConstraint(error)) throw new ConflictError(error.message);
        throw error;
      }
    },
  };
}

module.exports = { d1Adapter, ConflictError, isConstraint };
