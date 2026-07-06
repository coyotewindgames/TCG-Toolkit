-- Enable trigram matching support for typo-tolerant search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accelerate fuzzy/pattern lookups on product name.
CREATE INDEX IF NOT EXISTS products_name_trgm_idx
  ON products USING GIN (name gin_trgm_ops);

-- Accelerate fuzzy/pattern lookups on set name while skipping NULL rows.
CREATE INDEX IF NOT EXISTS products_set_name_trgm_idx
  ON products USING GIN (set_name gin_trgm_ops)
  WHERE set_name IS NOT NULL;
