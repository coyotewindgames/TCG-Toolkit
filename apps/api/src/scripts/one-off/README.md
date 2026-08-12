# One-off scripts

Completed data migrations and diagnostic tools. They are **not** part of the
running system: nothing in `src/server` or `src/jobs` imports them, and they are
kept only so a new environment can be brought to the same state as production.

- `backfill-artists.ts` — populate `products.artist` from PkmnPrices.
- `backfill-pkmnprices-ids.ts` — populate `products.pkmnpricesProductId`.
- `backfill-sku-barcodes.ts` — assign barcodes to SKUs created before barcodes existed.
- `diagnose-card.ts` — print everything the database knows about one card.

Delete a script once every environment has run it.
