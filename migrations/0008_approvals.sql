-- Four-eyes approvals: a change that grants access to a sensitive door is
-- stored as a request and only executed after a different operator (with
-- the same permission) approves it. The request is re-validated on approval.
CREATE TABLE IF NOT EXISTS approvals (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,          -- {"method","path","body"} of the original request
  locks TEXT NOT NULL,            -- JSON array of the sensitive lock ids involved
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | failed | rejected | cancelled | expired
  claim TEXT,                     -- random value written by the deciding request (compare-and-set)
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  result TEXT,                    -- JSON summary of the executed change or the error
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals (tenant_id, status, requested_at);

-- Door groups marked sensitive: every lock in them needs four-eyes approval
-- for new access (codes, assignments, group membership, directory mapping).
ALTER TABLE door_groups ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;
