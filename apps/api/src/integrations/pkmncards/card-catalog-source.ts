/**
 * Narrow contract the catalog enrichment job depends on: "given a catalog row,
 * find me an image". Keeping it separate from `PkmnCardsClient` means the job
 * can be pointed at any source (a different scraper, a paid API, a fake in
 * tests) without touching the job itself.
 */
import type { PkmnCardsLookupInput, PkmnCardsLookupResult } from './types';

export interface CardCatalogSource {
  lookup(input: PkmnCardsLookupInput): Promise<PkmnCardsLookupResult | null>;
}
