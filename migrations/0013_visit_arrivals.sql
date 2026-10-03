-- Visitor arrival: the first unlock with a visitor's code (TTLock callback or
-- record polling) is recorded once and the host is told.
-- code_macs: {"<lockId>": "<kid>:<hmac>"} keyed fingerprints of the visit's
-- codes (secrets-core codeMac) — lets an unlock record be matched without
-- storing the code. NULL when SECRETS_KEY is not set (no arrival detection).
ALTER TABLE visits ADD COLUMN code_macs TEXT;
ALTER TABLE visits ADD COLUMN arrived_at TEXT;
ALTER TABLE visits ADD COLUMN arrived_lock INTEGER;
-- The callback does not know the tenant: it looks up open visits by time (and lock).
CREATE INDEX IF NOT EXISTS visits_open ON visits (status, arrived_at, end_at);
