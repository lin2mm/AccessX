-- Relational, multi-tenant schema. Shared by Cloudflare D1 and Node's
-- built-in SQLite (same dialect, same file).
--
-- Every business row carries tenant_id and every primary key starts with
-- it, so a query that forgets the tenant cannot even address a row.
-- Arrays (lock_ids, group_ids, windows, perms, site_ids) are JSON columns
-- for now; see docs/ARCHITECTURE.md for when to move them to join tables.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  seeded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The pre-multi-tenant installation becomes the default tenant.
INSERT OR IGNORE INTO tenants (id, name) VALUES ('t_default', 'Default tenant');

CREATE TABLE IF NOT EXISTS sites (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  timezone TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS door_groups (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  lock_ids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS user_groups (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  site_id TEXT,                     -- NULL = cross-site group (owner-managed)
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS users (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,               -- personal data: never copied into audit_events
  email TEXT,                       -- personal data
  group_ids TEXT NOT NULL DEFAULT '[]',
  suspended INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS schedules (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  deny_on_holidays INTEGER NOT NULL DEFAULT 0,
  windows TEXT NOT NULL DEFAULT '[]',
  valid_from TEXT,
  valid_to TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS assignments (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  user_group_id TEXT NOT NULL,
  door_group_id TEXT NOT NULL,
  schedule_id TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS holidays (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  name TEXT,
  site_id TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS roles (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  perms TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS credentials (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT NOT NULL,            -- pseudonymous id only
  lock_id INTEGER NOT NULL,
  site_id TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  enforcement TEXT NOT NULL,
  rules TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,             -- active | pending_removal | revoked | expired
  vendor_ref TEXT,
  code_hint TEXT,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS credentials_status ON credentials (tenant_id, status);

-- Operators (administrators). Only the SHA-256 of a token is stored.
CREATE TABLE IF NOT EXISTS operators (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  site_ids TEXT,                    -- JSON array; NULL = all sites
  token_sha256 TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  PRIMARY KEY (tenant_id, id)
);

-- One hash chain PER TENANT: each tenant can verify its own history
-- without seeing anyone else's.
CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, seq)      -- concurrent writers collide here instead of forking
);
CREATE INDEX IF NOT EXISTS audit_events_action ON audit_events (tenant_id, action, seq);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- Carry the single-tenant chain (migration 0002) into the default
-- tenant's chain unchanged; hashes stay valid because tenant_id is not
-- part of the hashed content. audit_log is left in place as an archive.
INSERT OR IGNORE INTO audit_events (tenant_id, seq, id, ts, actor, action, detail, prev_hash, hash)
SELECT 't_default', seq, id, ts, actor, action, detail, prev_hash, hash FROM audit_log;
