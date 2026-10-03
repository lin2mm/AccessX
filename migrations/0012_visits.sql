-- Visitors: a visit is an invitation (who, host, doors, window). Its door codes
-- are ordinary credentials rows with visit_id set, so the reconciler, removal
-- SLA and revocation report cover them like any other code.
-- Personal data (name, email, company) lives ONLY here — never in the audit
-- chain, which cannot be edited — and is erased N days after the visit ends
-- (settings.visitors.retentionDays, default 30) or on request.
-- Not part of the tenant snapshot (grows with every visit): queried directly.
CREATE TABLE IF NOT EXISTS visits (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  visitor_name TEXT,               -- NULL once erased
  visitor_email TEXT,
  company TEXT,
  host_user_id TEXT NOT NULL,
  site_id TEXT,
  lock_ids TEXT NOT NULL,          -- JSON array
  start_at TEXT NOT NULL,          -- what the locks enforce (whole hours)
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | checked_out | cancelled
  delivery TEXT,                   -- shown | emailed | email_failed
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  ended_by TEXT,
  erased_at TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS visits_by_start ON visits (tenant_id, start_at);
CREATE INDEX IF NOT EXISTS visits_by_end ON visits (tenant_id, end_at);

ALTER TABLE credentials ADD COLUMN visit_id TEXT;
