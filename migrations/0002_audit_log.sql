-- Append-only, hash-chained audit trail (see audit-core.js).
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,           -- gap-free, assigned by the chain; a race fails on the PK
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log (action, seq);

-- The database itself refuses edits and deletions.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
