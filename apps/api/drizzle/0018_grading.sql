-- Graded cards become first-class: PSA/CGC/Beckett/TAG/SGC slabs get their own
-- grading_company/grade/cert_number on the SKU, a graded eBay price source, and
-- a widened identity so a PSA 10 and a raw NM copy of the same product are
-- distinct inventory lines. This migration is purely ADDITIVE — no backfill,
-- since no graded data has ever been persisted.

-- 1. Grading company enum.
DO $$ BEGIN
  CREATE TYPE card_grading_company AS ENUM ('psa', 'cgc', 'beckett', 'tag', 'sgc', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 2. New price source for aggregated graded eBay sold comps (added before the
--    manual escape hatch so it reads in preference order; override still wins).
ALTER TYPE price_source ADD VALUE IF NOT EXISTS 'pkmnprices_graded_ebay' BEFORE 'manual_override';

-- 3. Grading columns on skus. condition becomes nullable: for a graded SKU the
--    slab grade supersedes the in-house NM/LP/... tier.
ALTER TABLE skus
  ADD COLUMN IF NOT EXISTS grading_company card_grading_company,
  ADD COLUMN IF NOT EXISTS grade varchar(8),
  ADD COLUMN IF NOT EXISTS cert_number text;

ALTER TABLE skus ALTER COLUMN condition DROP NOT NULL;

-- 4. Widen SKU identity. The old table-level constraint keyed on
--    (product_id, condition, printing, language) with all columns NOT NULL.
--    Grading adds two nullable dimensions and condition is now nullable, so we
--    replace it with a NULLS NOT DISTINCT unique index (Postgres 15+): NULLs
--    compare equal, so raw duplicates still conflict (dedup preserved) while
--    graded variants (condition NULL, grading set) stay distinct from raw ones.
ALTER TABLE skus DROP CONSTRAINT IF EXISTS skus_identity_uq;
DROP INDEX IF EXISTS skus_identity_uq;

CREATE UNIQUE INDEX IF NOT EXISTS skus_identity_uq ON skus (
  product_id,
  condition,
  printing,
  language,
  grading_company,
  grade
) NULLS NOT DISTINCT;

-- 5. Cert lookup index (used later for duplicate-cert detection across trade-ins).
CREATE INDEX IF NOT EXISTS skus_cert_idx ON skus (cert_number);

-- 6. Enforce the raw-vs-graded shape: a raw SKU has a condition and no grade; a
--    graded SKU has a grading company + grade and no in-house condition.
ALTER TABLE skus DROP CONSTRAINT IF EXISTS skus_grade_ck;
ALTER TABLE skus ADD CONSTRAINT skus_grade_ck CHECK (
  (grading_company IS NULL AND condition IS NOT NULL)
  OR
  (grading_company IS NOT NULL AND grade IS NOT NULL AND condition IS NULL)
);
