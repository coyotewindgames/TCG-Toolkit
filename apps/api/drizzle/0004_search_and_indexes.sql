-- Adds the GENERATED tsvector column referenced by schema.ts (searchTsv) plus
-- a GIN index for full-text product search. Drizzle's `push` cannot express
-- GENERATED columns so this migration is hand-authored.
--
-- Also adds a couple of useful operational indexes that aren't expressible via
-- the drizzle schema today:
--   * partial index on webhook_events for failed-signature triage
--   * customer email index scoped per store
--
-- Safe to run multiple times: every statement is guarded with IF NOT EXISTS.

ALTER TABLE products
  DROP COLUMN IF EXISTS search_tsv;

ALTER TABLE products
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(name, '') || ' ' ||
      coalesce(set_name, '') || ' ' ||
      coalesce(card_number, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS products_search_tsv_gin
  ON products USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS webhook_events_failed_idx
  ON webhook_events (received_at DESC)
  WHERE signature_ok = false;

CREATE INDEX IF NOT EXISTS customers_email_per_store_idx
  ON customers (store_id, lower(email));
