-- Audit anchoring, export and retention.

-- Signed snapshots of a tenant's audit head. A copy goes somewhere the app
-- cannot write (customer webhook, auditor's inbox); if anyone later
-- rewrites the chain, the hash at that seq no longer matches the anchor.
CREATE TABLE IF NOT EXISTS audit_anchors (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  key_id TEXT,                 -- Ed25519 key id (NULL = unsigned: no AUDIT_SIGNING_KEY)
  signature TEXT,              -- base64url Ed25519 over "accessx-anchor-v1\n{tenant}\n{seq}\n{hash}\n{created_at}"
  delivered_to TEXT,           -- webhook host, if any
  delivery_status TEXT,        -- delivered | failed: … | none
  PRIMARY KEY (tenant_id, seq)
);

-- Retention: entries up to `seq` were purged; the first remaining entry
-- chains onto `hash`. Verification starts here instead of at GENESIS.
CREATE TABLE IF NOT EXISTS audit_checkpoints (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  anchor_seq INTEGER NOT NULL, -- the external anchor that covers the purged range
  PRIMARY KEY (tenant_id, seq)
);

-- The chain stays append-only, with one controlled exception: rows at or
-- below a recorded checkpoint may be deleted (retention). Everything else
-- is still rejected. (Raw database access can drop triggers — the anchors
-- are what catch that.)
DROP TRIGGER IF EXISTS audit_events_no_delete;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
WHEN NOT EXISTS (SELECT 1 FROM audit_checkpoints c WHERE c.tenant_id = OLD.tenant_id AND c.seq >= OLD.seq)
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only (purge only below a retention checkpoint)');
END;

-- Anchors and checkpoints are permanent.
CREATE TRIGGER IF NOT EXISTS audit_anchors_no_change
BEFORE UPDATE ON audit_anchors
BEGIN
  SELECT RAISE(ABORT, 'audit_anchors is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_anchors_no_delete
BEFORE DELETE ON audit_anchors
BEGIN
  SELECT RAISE(ABORT, 'audit_anchors is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_checkpoints_no_change
BEFORE UPDATE ON audit_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'audit_checkpoints is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_checkpoints_no_delete
BEFORE DELETE ON audit_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'audit_checkpoints is append-only');
END;

-- Deliberate no-op: a trigger must not be the last statement of a migration
-- (D1 remote splitter, cloudflare/workers-sdk#15314). Harmless where already applied.
UPDATE app_state SET key = key WHERE 0;
