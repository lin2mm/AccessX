-- Enforced single sign-on needs a way back in when the identity provider is
-- down or misconfigured: break-glass operators may still use a token.
-- Every break-glass sign-in is audited as operator.break_glass.
ALTER TABLE operators ADD COLUMN break_glass INTEGER NOT NULL DEFAULT 0;
