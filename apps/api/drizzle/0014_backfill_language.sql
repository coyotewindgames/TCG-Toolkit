-- Heuristic language backfill. Any SKU whose product's set_name mentions
-- "Japanese" (case-insensitive) is flipped from the default 'EN' to 'JP'.
-- This is best-effort: operators can still correct individual SKUs by hand.
UPDATE skus s
SET language = 'JP'
FROM products p
WHERE s.product_id = p.id
  AND s.language = 'EN'
  AND (
    lower(p.set_name) LIKE '%japanese%'
    OR lower(p.set_name) LIKE '%(jp)%'
    OR lower(p.name)     LIKE '%(japanese)%'
  );
