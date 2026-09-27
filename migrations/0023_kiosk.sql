-- R16 front-desk kiosk (docs/22-KIOSK.md).
-- A kiosk is a paired tablet at one site's reception. Its key is stored as a
-- SHA-256 only and can do nothing but kiosk actions (never an operator).
CREATE TABLE IF NOT EXISTS kiosks (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  PRIMARY KEY (tenant_id, id)
);

-- Visitors who arrive without an invitation. No door code is issued from the
-- kiosk: the host is told, and reception decides (issue a code or dismiss).
-- Personal details follow the tenant's visitor retention period.
CREATE TABLE IF NOT EXISTS walkins (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  kiosk_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  visitor_name TEXT,
  company TEXT,
  visitor_email TEXT,
  host_user_id TEXT,
  notice_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | issued | dismissed
  visit_id TEXT,
  host_notified TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  erased_at TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS walkins_open ON walkins (tenant_id, status, created_at);

-- Signing in at the kiosk (separate from the first door opening, arrived_at),
-- and which version of the visitor notice was accepted (SHA-256 of its text).
ALTER TABLE visits ADD COLUMN checked_in_at TEXT;
ALTER TABLE visits ADD COLUMN notice_sha256 TEXT;
