-- Decommission TCGapi.dev integration (Part A, Option 3).
--
-- PkmnPrices is now the sole automated pricing/catalog provider for Pokémon;
-- non-Pokémon games are manual-only. The per-store TCGapi credential table is
-- no longer read or written by any code path, so drop it.
--
-- Intentionally KEPT for provenance / backwards compatibility:
--   * price_source enum values tcgapi_market / tcgapi_low / tcgapi_median /
--     tcgapi_buylist  (historical price_snapshots still reference them)
--   * products.tcgapi_product_id column + products_tcgapi_idx  (legacy id
--     mapping retained as provenance)

DROP TABLE IF EXISTS "tcgapi_configs";
