-- 0003_password_resets
-- One-time, single-use tokens for the forgot-password flow. We only ever
-- persist the SHA-256 hash of the emailed token; the plaintext exists only
-- on the wire and in the user's inbox.
-- Idempotent so dev resets don't fight the __drizzle_migrations tracker.

CREATE TABLE IF NOT EXISTS password_resets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  requested_ip  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS password_resets_hash_uq ON password_resets (token_hash);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);
