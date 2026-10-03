-- Snapshot cache versioning (store/repo.js).
-- Every insert/update/delete on a table that makes up the tenant snapshot bumps
-- tenants.data_version and logs (version, table, row id) in snapshot_changes —
-- whichever code path (or manual SQL) wrote it. A process holding a cached
-- snapshot checks data_version (it reads the tenant row anyway) and refetches
-- only the rows logged since its version: O(changes) instead of O(tenant).
-- Maintenance keeps the newest changes per tenant; a cache that fell further
-- behind simply reloads in full.
--
-- D1 remote migration splitter: keep BEGIN uppercase, LF line endings, no CASE
-- inside trigger bodies, and never end this file with a trigger
-- (cloudflare/workers-sdk#15314). test/snapshot-cache.test.js checks this.
ALTER TABLE tenants ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS snapshot_changes (
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, version)
);

CREATE TRIGGER IF NOT EXISTS snap_sites_insert AFTER INSERT ON sites
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'sites', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_sites_update AFTER UPDATE ON sites
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'sites', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_sites_delete AFTER DELETE ON sites
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'sites', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_door_groups_insert AFTER INSERT ON door_groups
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'door_groups', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_door_groups_update AFTER UPDATE ON door_groups
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'door_groups', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_door_groups_delete AFTER DELETE ON door_groups
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'door_groups', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_user_groups_insert AFTER INSERT ON user_groups
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'user_groups', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_user_groups_update AFTER UPDATE ON user_groups
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'user_groups', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_user_groups_delete AFTER DELETE ON user_groups
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'user_groups', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_users_insert AFTER INSERT ON users
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'users', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_users_update AFTER UPDATE ON users
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'users', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_users_delete AFTER DELETE ON users
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'users', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_schedules_insert AFTER INSERT ON schedules
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'schedules', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_schedules_update AFTER UPDATE ON schedules
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'schedules', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_schedules_delete AFTER DELETE ON schedules
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'schedules', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_assignments_insert AFTER INSERT ON assignments
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'assignments', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_assignments_update AFTER UPDATE ON assignments
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'assignments', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_assignments_delete AFTER DELETE ON assignments
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'assignments', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_holidays_insert AFTER INSERT ON holidays
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'holidays', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_holidays_update AFTER UPDATE ON holidays
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'holidays', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_holidays_delete AFTER DELETE ON holidays
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'holidays', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_roles_insert AFTER INSERT ON roles
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'roles', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_roles_update AFTER UPDATE ON roles
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'roles', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_roles_delete AFTER DELETE ON roles
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'roles', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_directory_groups_insert AFTER INSERT ON directory_groups
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'directory_groups', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_directory_groups_update AFTER UPDATE ON directory_groups
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'directory_groups', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_directory_groups_delete AFTER DELETE ON directory_groups
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'directory_groups', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_credentials_insert AFTER INSERT ON credentials
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'credentials', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_credentials_update AFTER UPDATE ON credentials
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = NEW.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT NEW.tenant_id, data_version, 'credentials', NEW.id FROM tenants WHERE id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS snap_credentials_delete AFTER DELETE ON credentials
BEGIN
  UPDATE tenants SET data_version = data_version + 1 WHERE id = OLD.tenant_id;
  INSERT INTO snapshot_changes (tenant_id, version, tbl, row_id) SELECT OLD.tenant_id, data_version, 'credentials', OLD.id FROM tenants WHERE id = OLD.tenant_id;
END;

-- Deliberate no-op: the last statement of this file must not be a trigger (see header).
UPDATE tenants SET data_version = data_version WHERE 0;
