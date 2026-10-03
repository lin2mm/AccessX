-- Visitor pre-registration (docs/PREREGISTRATION.md). The invite is the
-- operator's approval of host, doors and window; the visitor adds their name
-- (and may pick an arrival time inside the window). The code goes only to
-- `contact`, fixed by the operator. Only the token's SHA-256 is stored.
-- contact / submitted_* are personal data: erased with the visit or by retention.
CREATE TABLE IF NOT EXISTS visit_invites (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  token_hash TEXT,
  host_user_id TEXT NOT NULL,
  site_id TEXT,
  lock_ids TEXT NOT NULL,
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  contact TEXT,
  require_approval INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  submitted_name TEXT,
  submitted_company TEXT,
  submitted_start TEXT,
  submitted_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_by TEXT,
  visit_id TEXT,
  erased_at TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS visit_invites_token ON visit_invites (token_hash);
CREATE INDEX IF NOT EXISTS visit_invites_status ON visit_invites (tenant_id, status, expires_at);
