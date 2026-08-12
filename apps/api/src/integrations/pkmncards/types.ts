/** Shared types for the pkmncards scraper (transport, parsing and matching). */

export interface PkmnCardsLookupInput {
  name: string;
  setCode: string | null;
  setName: string | null;
  cardNumber: string | null;
}

export interface PkmnCardsLookupResult {
  imageUrl: string;
  cardUrl: string | null;
  method: 'deterministic' | 'search';
}

export interface SetMeta {
  slug: string;
  name: string;
  code: string;
}

/** Directory entry pulled from `pkmn_artist-sitemap.xml`. */
export interface ArtistDirectoryEntry {
  slug: string;
  /** Slug rewritten as a display label, e.g. `yuka-morii` → `Yuka Morii`. */
  displayName: string;
}

/** Card URL parsed from an artist index page, e.g. `/card/aipom-paradox-rift-par-211/`. */
export interface ParsedCardUrl {
  cardUrl: string;
  /** Best-guess slug for the card name (may include hyphens). */
  nameSlug: string;
  /** Set slug (may be null if we can't align with the known set directory). */
  setSlug: string | null;
  /** Set code (2–5 alpha chars) — the reliable join key. */
  setCode: string;
  /** Card number as it appears on the printed card. */
  number: string;
}

/** A single hit returned by {@link PkmnCardsClient.searchByArtistSlug}. */
export interface ArtistCardHit extends ParsedCardUrl {
  /** Best-effort display name from the slug (Title Case). */
  displayName: string;
}

/** Result of {@link PkmnCardsClient.resolveArtistSlug}. */
export interface ResolvedArtist {
  slug: string;
  displayName: string;
  /** How we found the slug — used only for logging/analytics. */
  method: 'direct' | 'exact' | 'substring' | 'tokens' | 'lastname' | 'levenshtein';
}
