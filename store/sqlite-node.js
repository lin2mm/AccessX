/** Node adapter (built-in node:sqlite) + migration runner. Server only. */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ConflictError, isConstraint } = require('./sql');

function nodeSqliteAdapter(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const plain = row => (row ? { ...row } : null);
  return {
    kind: 'sqlite',
    raw: db,
    async all(sql, params = []) { return db.prepare(sql).all(...params).map(plain); },
    async first(sql, params = []) { return plain(db.prepare(sql).get(...params)); },
    async batch(statements) {
      if (!statements.length) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        if (isConstraint(error)) throw new ConflictError(error.message);
        throw error;
      }
    },
    close() { db.close(); },
  };
}

/** Apply migrations/*.sql in order (Node only; Wrangler does this for D1). */
function migrateNode(adapter, migrationsDir) {
  const db = adapter.raw;
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
      applied.push(file);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${error.message}`);
    }
  }
  return applied;
}

module.exports = { nodeSqliteAdapter, migrateNode };
