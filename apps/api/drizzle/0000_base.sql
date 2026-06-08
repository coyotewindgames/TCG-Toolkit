-- 0000_base
-- Complete initial schema for a fresh database.
-- Every statement is idempotent (IF NOT EXISTS / DO-EXCEPTION blocks) so this
-- is also safe to replay against an existing database without data loss.

-- ---- enums ----------------------------------------------------------------
-- Postgres has no CREATE TYPE IF NOT EXISTS; use a DO block instead.

DO $$ BEGIN CREATE TYPE card_condition AS ENUM ('NM','LP','MP','HP','DMG'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE card_printing AS ENUM ('Normal','Foil','Reverse','Holo','FirstEdition'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE card_language AS ENUM ('EN','JP','DE','FR','IT','ES','PT','KO','CN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE user_role    AS ENUM ('owner','manager','clerk','buyer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE order_status AS ENUM ('open','pending_payment','paid','voided','refunded','partially_refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE trade_status AS ENUM ('draft','pending_approval','approved','rejected','completed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payout_kind  AS ENUM ('cash','store_credit'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE pos_provider AS ENUM ('clover'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE price_source AS ENUM ('tcgapi_market','tcgapi_low','tcgapi_median','tcgapi_buylist','manual_override'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE game         AS ENUM ('mtg','pokemon','yugioh','lorcana','one_piece','flesh_and_blood','sealed','supplies','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- tenancy --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stores (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  timezone             text NOT NULL DEFAULT 'America/New_York',
  default_pos_provider pos_provider NOT NULL DEFAULT 'clover',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       text NOT NULL,
  address    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS locations_store_idx ON locations (store_id);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text NOT NULL,
  role          user_role NOT NULL DEFAULT 'clerk',
  password_hash text,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_store_uq UNIQUE (store_id, email)
);

CREATE TABLE IF NOT EXISTS customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name                text,
  email               text,
  phone               text,
  store_credit_cents  bigint NOT NULL DEFAULT 0,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_store_idx  ON customers (store_id);
CREATE INDEX IF NOT EXISTS customers_email_idx  ON customers (email);

-- ---- catalog --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  tcgapi_product_id  text,
  game               game NOT NULL DEFAULT 'other',
  name               text NOT NULL,
  set_name           text,
  set_id             text,
  card_number        text,
  rarity             text,
  type               text,
  image_source_url   text,
  attributes         jsonb NOT NULL DEFAULT '{}',
  search_tsv         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_store_idx  ON products (store_id);
CREATE INDEX IF NOT EXISTS products_tcgapi_idx ON products (tcgapi_product_id);
CREATE INDEX IF NOT EXISTS products_name_idx   ON products (name);

CREATE TABLE IF NOT EXISTS skus (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id     uuid NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  condition    card_condition NOT NULL,
  printing     card_printing  NOT NULL,
  language     card_language  NOT NULL DEFAULT 'EN',
  barcode      varchar(64)    NOT NULL,
  internal_sku varchar(64)    NOT NULL,
  created_at   timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT skus_barcode_uq   UNIQUE (barcode),
  CONSTRAINT skus_identity_uq  UNIQUE (product_id, condition, printing, language)
);
CREATE INDEX IF NOT EXISTS skus_product_idx ON skus (product_id);

-- ---- inventory ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory (
  sku_id          uuid    NOT NULL REFERENCES skus(id)      ON DELETE CASCADE,
  location_id     uuid    NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  qty_on_hand     integer NOT NULL DEFAULT 0,
  qty_reserved    integer NOT NULL DEFAULT 0,
  cost_avg_cents  integer NOT NULL DEFAULT 0,
  bin             text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, location_id)
);
CREATE INDEX IF NOT EXISTS inventory_location_idx ON inventory (location_id);

-- ---- pricing --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS price_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id       uuid         NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  source       price_source NOT NULL,
  price_cents  integer      NOT NULL,
  sample_size  integer,
  captured_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_snapshots_sku_idx    ON price_snapshots (sku_id, captured_at);
CREATE INDEX IF NOT EXISTS price_snapshots_source_idx ON price_snapshots (source, captured_at);

CREATE TABLE IF NOT EXISTS current_prices (
  sku_id               uuid PRIMARY KEY REFERENCES skus(id) ON DELETE CASCADE,
  sell_price_cents     integer NOT NULL,
  buy_price_cents      integer NOT NULL DEFAULT 0,
  market_price_cents   integer,
  market_median_cents  integer,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ---- orders ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid         NOT NULL REFERENCES stores(id)    ON DELETE CASCADE,
  location_id     uuid         NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  customer_id     uuid         REFERENCES customers(id)          ON DELETE SET NULL,
  register_id     text,
  status          order_status NOT NULL DEFAULT 'open',
  subtotal_cents  integer      NOT NULL DEFAULT 0,
  tax_cents       integer      NOT NULL DEFAULT 0,
  tip_cents       integer      NOT NULL DEFAULT 0,
  total_cents     integer      NOT NULL DEFAULT 0,
  pos_provider    pos_provider,
  pos_order_id    text,
  pos_checkout_id text,
  receipt_url     text,
  created_by      uuid         REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS orders_store_idx ON orders (store_id, status);
CREATE INDEX IF NOT EXISTS orders_pos_idx   ON orders (pos_order_id);

CREATE TABLE IF NOT EXISTS order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_id                uuid    NOT NULL REFERENCES skus(id)   ON DELETE RESTRICT,
  quantity              integer NOT NULL,
  unit_price_cents      integer NOT NULL,
  discount_cents        integer NOT NULL DEFAULT 0,
  product_name_snapshot text,
  tax_rate_bps          integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

CREATE TABLE IF NOT EXISTS payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid         NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider            pos_provider NOT NULL,
  provider_payment_id text,
  amount_cents        integer      NOT NULL,
  status              text         NOT NULL,
  raw_payload         jsonb,
  created_at          timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);

-- ---- trade-ins ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trade_ins (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid         NOT NULL REFERENCES stores(id)    ON DELETE CASCADE,
  location_id       uuid         NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  customer_id       uuid         REFERENCES customers(id)          ON DELETE SET NULL,
  status            trade_status NOT NULL DEFAULT 'draft',
  payout            payout_kind  NOT NULL,
  total_value_cents integer      NOT NULL DEFAULT 0,
  signature_url     text,
  id_image_url      text,
  approved_by       uuid         REFERENCES users(id) ON DELETE SET NULL,
  created_by        uuid         REFERENCES users(id) ON DELETE SET NULL,
  barcode           varchar(64),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT trade_ins_barcode_uq UNIQUE (barcode)
);
CREATE INDEX IF NOT EXISTS trade_ins_customer_idx ON trade_ins (customer_id);

CREATE TABLE IF NOT EXISTS trade_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id         uuid    NOT NULL REFERENCES trade_ins(id) ON DELETE CASCADE,
  sku_id           uuid    NOT NULL REFERENCES skus(id)      ON DELETE RESTRICT,
  quantity         integer NOT NULL,
  unit_value_cents integer NOT NULL,
  barcode          varchar(64),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_items_trade_idx ON trade_items (trade_id);

-- ---- audit + idempotency --------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid REFERENCES stores(id)  ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id)   ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_actor_idx  ON audit_log (actor_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  signature_ok      boolean     NOT NULL,
  payload           jsonb       NOT NULL,
  processed_at      timestamptz,
  received_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_events_provider_id_uq UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_type_idx      ON webhook_events (provider, event_type);
CREATE INDEX IF NOT EXISTS webhook_events_signature_idx ON webhook_events (signature_ok, received_at);

-- ---- auth -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_tokens_hash_uq UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  requested_ip  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_resets_hash_uq UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);

-- ---- third-party config tables (from 0002) --------------------------------

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
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  action     text NOT NULL,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_ip   text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS config_audit_store_idx ON config_audit_log (store_id, at);
