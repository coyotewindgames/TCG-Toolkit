-- Store card artist so the inventory page can search by artist and display
-- it on tiles. Populated by the pkmnprices backfill script for products with
-- a `pkmnprices_product_id`; NULL for others.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS artist text;

-- Accelerate fuzzy/pattern lookups on artist while skipping NULL rows.
CREATE INDEX IF NOT EXISTS products_artist_trgm_idx
  ON products USING GIN (artist gin_trgm_ops)
  WHERE artist IS NOT NULL;

-- B-tree for exact-match filtering.
CREATE INDEX IF NOT EXISTS products_artist_idx
  ON products (artist)
  WHERE artist IS NOT NULL;
