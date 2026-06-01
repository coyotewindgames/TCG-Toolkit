-- 0001_simplify
-- 1. Drop unused scaffolding columns (never read, never written by current code).
ALTER TABLE products DROP COLUMN IF EXISTS external_product_id;
ALTER TABLE products DROP COLUMN IF EXISTS image_cdn_url;
ALTER TABLE skus     DROP COLUMN IF EXISTS tcgapi_sku_id;

-- 2. Realign price_source enum to the fields tcgapi.dev actually returns.
--    Old:  tcgapi_market, tcgapi_low, tcgapi_mid,    tcgapi_high,    manual_override
--    New:  tcgapi_market, tcgapi_low, tcgapi_median, tcgapi_buylist, manual_override
--    Postgres cannot drop enum values in place; rename old, create new,
--    rewrite the column, drop old.
ALTER TYPE price_source RENAME TO price_source_old;

CREATE TYPE price_source AS ENUM (
  'tcgapi_market',
  'tcgapi_low',
  'tcgapi_median',
  'tcgapi_buylist',
  'manual_override'
);

ALTER TABLE price_snapshots
  ALTER COLUMN source TYPE price_source
  USING (
    CASE source::text
      WHEN 'tcgapi_mid'  THEN 'tcgapi_median'
      WHEN 'tcgapi_high' THEN 'tcgapi_buylist'
      ELSE source::text
    END
  )::price_source;

DROP TYPE price_source_old;

-- 3. Drop the image-mirror queue's residue: nothing to drop in SQL because
--    BullMQ owns its own Redis keys. Documenting here for future readers.
