-- Per-product PkmnPrices card id (integer in the PkmnPrices API). Nullable
-- so existing rows aren't broken; the router falls back to tcgapi when this
-- is unset, and a backfill script resolves it in batches.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pkmnprices_product_id integer;

CREATE INDEX IF NOT EXISTS products_pkmnprices_idx
  ON products (pkmnprices_product_id);
