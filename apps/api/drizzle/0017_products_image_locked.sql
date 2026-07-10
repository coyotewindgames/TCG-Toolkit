-- Track whether a product's image was explicitly set (or cleared) by a user
-- so the automated enrichment job leaves it alone on subsequent runs.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_locked boolean NOT NULL DEFAULT false;
