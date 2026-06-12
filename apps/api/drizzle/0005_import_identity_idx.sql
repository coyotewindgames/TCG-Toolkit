-- Speeds up importer product identity lookup used on each row.
-- Safe to run repeatedly.

CREATE INDEX IF NOT EXISTS products_import_identity_idx
  ON products (store_id, game, name, set_name, card_number);
