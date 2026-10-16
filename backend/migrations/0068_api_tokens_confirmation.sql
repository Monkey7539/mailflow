-- How each API token was confirmed when it was made (#617), so that a change to the server's
-- sign-in policy can delete the tokens it no longer allows: 'password', 'totp' or 'oidc'. A token
-- made before this was recorded has none, and counts as confirmed with a password only. A token
-- confirmed through single sign-on names its provider, and goes when the provider is deleted.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS confirmed_with VARCHAR(10)
  CHECK (confirmed_with IN ('password', 'totp', 'oidc'));
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS oidc_provider_id UUID REFERENCES oidc_providers(id) ON DELETE CASCADE;

-- Every token expires now. One made without an expiry gets the longest there is: a year from
-- when it was made.
UPDATE api_tokens SET expires_at = created_at + INTERVAL '365 days' WHERE expires_at IS NULL;
ALTER TABLE api_tokens ALTER COLUMN expires_at SET NOT NULL;
