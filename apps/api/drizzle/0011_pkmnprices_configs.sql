CREATE TABLE IF NOT EXISTS pkmnprices_configs (
  store_id uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  base_url text NOT NULL DEFAULT 'https://api.pkmnprices.com/v1',
  api_key_ciphertext text NOT NULL,
  api_key_iv text NOT NULL,
  api_key_tag text NOT NULL,
  tier text NOT NULL DEFAULT 'free',
  key_version integer NOT NULL DEFAULT 1,
  last_verified_at timestamptz,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
