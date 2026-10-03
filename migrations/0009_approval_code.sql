-- Four-eyes passcodes: the code of an approved request is sealed (SECRETS_KEY,
-- bound to tenant + approval id) for the requester, who collects it once.
-- The approver never sees it.
ALTER TABLE approvals ADD COLUMN sealed_code TEXT;
ALTER TABLE approvals ADD COLUMN collected_at TEXT;
