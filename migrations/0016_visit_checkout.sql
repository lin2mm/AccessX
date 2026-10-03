-- Self check-out link: SHA-256 of a random token sent to the visitor with
-- their code. Cleared when the visit ends, is cancelled or erased.
ALTER TABLE visits ADD COLUMN checkout_token_hash TEXT;
CREATE INDEX IF NOT EXISTS visits_checkout_token ON visits (checkout_token_hash);
