-- R18 access review (ISO 27001 A.5.18, SOC 2 CC6.2/CC6.3) and passcode sweep
-- (docs/24-ACCESS-REVIEW.md).
--
-- A review freezes "who can open which doors, who administers what" at its
-- start. Reviewers keep or remove each line; removing acts at once. Items hold
-- ids, never names: names are resolved when shown, so erasing a person still
-- works. At most one open review per tenant.
CREATE TABLE IF NOT EXISTS access_reviews (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  status TEXT NOT NULL, -- open | closed
  started_at TEXT NOT NULL,
  started_by TEXT NOT NULL,
  due_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT,
  close_note TEXT,
  notified_at TEXT,          -- reviewers told the review started
  reminded_at TEXT,          -- reminder before the due date
  overdue_notified_at TEXT,  -- owners told it is overdue
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS access_reviews_one_open ON access_reviews (tenant_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS access_review_items (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  review_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,        -- door (a person's doors at one site) | admin (an operator)
  site_id TEXT,              -- door items: the site; admin items: NULL
  subject_id TEXT NOT NULL,  -- user id (door) or operator id (admin)
  detail TEXT NOT NULL,      -- JSON: door ids + group ids + active codes, or role + sites
  decision TEXT,             -- NULL | keep | remove
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  outcome TEXT,              -- what "remove" did, or why it could not finish
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS access_review_items_review ON access_review_items (tenant_id, review_id);

-- One row per sweep: codes on the locks compared with the registry (counts only;
-- never the code digits, never code names).
CREATE TABLE IF NOT EXISTS passcode_sweeps (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  lock_count INTEGER NOT NULL,
  summary TEXT NOT NULL,     -- JSON counts by class, and locks that could not be read
  PRIMARY KEY (tenant_id, id)
);
