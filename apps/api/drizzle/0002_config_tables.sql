-- 0002_config_tables
-- Per-store encrypted credentials for TCGapi.dev and Clover. The plaintext
-- never lives in this database; the application encrypts/decrypts with
-- AES-256-GCM using CONFIG_ENCRYPTION_KEY from env. See `vault.ts`.
-- Idempotent (IF NOT EXISTS) so this can be re-run safely if the
-- __drizzle_migrations tracker is out of sync with the live schema.

CREATE TABLE IF NOT EXISTS tcgapi_configs (
  store_id            uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  base_url            text NOT NULL DEFAULT 'https://api.tcgapi.dev/v1',
  api_key_ciphertext  text NOT NULL,
  api_key_iv          text NOT NULL,
  api_key_tag         text NOT NULL,
  key_version         integer NOT NULL DEFAULT 1,
  last_verified_at    timestamptz,
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pos_configs (
  store_id                    uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  provider                    pos_provider NOT NULL DEFAULT 'clover',
  base_url                    text NOT NULL,
  -- merchant_id is plaintext so the webhook handler can locate the store from
  -- the inbound `merchants[0].id` BEFORE decrypting the signing secret.
  merchant_id                 text NOT NULL,
  access_token_ciphertext     text NOT NULL,
  access_token_iv             text NOT NULL,
  access_token_tag            text NOT NULL,
  webhook_secret_ciphertext   text NOT NULL,
  webhook_secret_iv           text NOT NULL,
  webhook_secret_tag          text NOT NULL,
  key_version                 integer NOT NULL DEFAULT 1,
  last_verified_at            timestamptz,
  updated_by                  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pos_configs_merchant_uq ON pos_configs (merchant_id);

CREATE TABLE IF NOT EXISTS config_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  table_name  text NOT NULL,
  action      text NOT NULL,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_ip    text,
  at          timestamptz NOT NULL DEFAULT now()
  -- intentionally no before/after value columns; never log plaintext
);

CREATE INDEX IF NOT EXISTS config_audit_store_idx ON config_audit_log (store_id, at);
