/**
 * Append-only audit store for the Express server: DATA_DIR/audit.jsonl.
 * One sealed entry per line; the file is only ever appended to.
 * (Production: a database table with UPDATE/DELETE revoked, as the
 * Worker does with D1 triggers — see migrations/0002_audit_log.sql.)
 */
const fs = require('fs');
const path = require('path');
const auditCore = require('./audit-core');

function createAuditStore(dataDir) {
  const file = path.join(dataDir, 'audit.jsonl');
  let head = null;

  function readAll() {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  function getHead() {
    if (!head) {
      const last = readAll().at(-1);
      head = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: auditCore.GENESIS };
    }
    return head;
  }

  function isEmpty() { return getHead().seq === 0; }

  function append(pendingEntries) {
    if (!pendingEntries || !pendingEntries.length) return [];
    const sealed = auditCore.seal(getHead(), pendingEntries);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(file, sealed.map(e => JSON.stringify(e)).join('\n') + '\n');
    const last = sealed.at(-1);
    head = { seq: last.seq, hash: last.hash };
    return sealed;
  }

  /** Newest first. `before` = only entries with seq < before (pagination). */
  function recent({ limit = 100, before = null, action = null } = {}) {
    let list = readAll();
    if (before) list = list.filter(e => e.seq < before);
    if (action) list = list.filter(e => e.action === action);
    return list.slice(-Math.min(Math.max(limit, 1), 1000)).reverse();
  }

  function verify() { return auditCore.verify(readAll()); }

  return { append, recent, verify, getHead, isEmpty, file };
}

module.exports = { createAuditStore };
