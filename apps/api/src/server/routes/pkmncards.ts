/**
 * Per-store proxy in front of pkmncards.com's HTML site. This complements the
 * `/pkmnprices/*` API by giving the Trade / Buy search box a first-class
 * artist-search path that upstream pkmnprices doesn't offer.
 *
 *   GET /pkmncards/artist-search?name=&page=&perPage=
 *
 * Flow:
 *   1. Fuzzy-resolve the typed artist name to a canonical pkmncards slug.
 *   2. Scrape the artist page for card links + parse `{name, set-code, number}`.
 *   3. Hydrate each parsed card back to a pkmnprices id via
 *      `searchCards({ set_id, number })` so the Trade UI can add it to the
 *      queue and pull market prices exactly like a normal name-search hit.
 *
 * Results are cached in a module-scoped LRU (15 min TTL) keyed by
 * `${storeId}|${slug}|${page}|${perPage}` so repeated searches don't hammer
 * pkmncards or waste pkmnprices credits.
 */
import { Router } from 'express';
import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest } from '../../common/http-errors';
import type { ArtistCardHit, ResolvedArtist } from '../../integrations/pkmncards/client';
import type { PkmnpricesCardSummary } from '../../integrations/pkmnprices/client';
import { requireAuth } from '../auth/middleware';
import type { Container } from '../container';

// Response shape mirrors /pkmnprices/search so the web layer can reuse
// TcgapiCard rendering without a translation shim.
interface TcgapiCardShape {
  id: string;
  name: string;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  setId: string | null;
  setName: string | null;
  artist: string | null;
  gameSlug: 'pokemon';
  gameName: 'Pokémon';
}

interface ArtistSearchResponse {
  results: TcgapiCardShape[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total: number;
  resolvedArtist: { slug: string; displayName: string; method: ResolvedArtist['method'] } | null;
}

const ArtistSearchQuery = z.object({
  name: z.string().trim().min(1).max(120),
  page: z.coerce.number().int().positive().max(50).optional(),
  perPage: z.coerce.number().int().positive().max(48).optional(),
});

const HYDRATION_CONCURRENCY = 3;
const CACHE_TTL_MS = 15 * 60_000;
const cache = new LRUCache<string, { body: ArtistSearchResponse; expiresAt: number }>({ max: 500 });

function cacheGet(key: string): ArtistSearchResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}

function cacheSet(key: string, body: ArtistSearchResponse): void {
  cache.set(key, { body, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function pkmncardsRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/artist-search',
    asyncHandler(async (req, res) => {
      const parsed = ArtistSearchQuery.safeParse(req.query);
      if (!parsed.success) throw BadRequest('invalid artist search params', parsed.error.flatten());
      const { name } = parsed.data;
      const perPage = parsed.data.perPage ?? 24;
      const page = parsed.data.page ?? 1;
      const storeId = req.user!.storeId;

      // pkmnprices creds are needed for hydration (we still return the raw
      // pkmncards hits with a null id if the store isn't configured, so the
      // UI can degrade gracefully — but we prefer the fully hydrated path).
      const status = await c.configs.getPkmnpricesStatus(storeId);
      const canHydrate = status.configured && status.hasKey;

      // Resolve the free-text artist name to a canonical slug up-front so
      // the cache key is stable across typos ("yuka mori" and "yuka morii"
      // both hit the same cache entry once the slug is known).
      const resolved = await c.pkmncardsClient.resolveArtistSlug(name);
      if (!resolved) {
        const empty: ArtistSearchResponse = {
          results: [],
          page,
          perPage,
          hasMore: false,
          total: 0,
          resolvedArtist: null,
        };
        res.json(empty);
        return;
      }

      const cacheKey = `${storeId}|artist_v1|${resolved.slug}|${page}|${perPage}|${canHydrate ? '1' : '0'}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const rawHits = await c.pkmncardsClient.searchByArtistSlug(resolved.slug, page);
      const paged = rawHits.slice(0, perPage);

      const hydrated: TcgapiCardShape[] = canHydrate
        ? await hydrateHits(paged, c, storeId)
        : paged.map((h) => degradedShape(h));

      const body: ArtistSearchResponse = {
        results: hydrated,
        page,
        perPage,
        // We requested one page from pkmncards and dedupe/slice locally; if the
        // page returned a full window there's likely more available upstream.
        hasMore: rawHits.length >= perPage,
        total: hydrated.length,
        resolvedArtist: {
          slug: resolved.slug,
          displayName: resolved.displayName,
          method: resolved.method,
        },
      };
      cacheSet(cacheKey, body);
      res.json(body);
    }),
  );

  return r;
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/**
 * Convert each parsed pkmncards hit into a pkmnprices card. We batch by
 * (set_id, number) since a card in a set is unique by number. Concurrency is
 * bounded so bursty artist searches don't blow the store's pkmnprices quota.
 */
async function hydrateHits(
  hits: ArtistCardHit[],
  c: Container,
  storeId: string,
): Promise<TcgapiCardShape[]> {
  if (hits.length === 0) return [];
  const pricesClient = await c.pkmnpricesFor(storeId);
  const limit = pLimit(HYDRATION_CONCURRENCY);

  const tasks = hits.map((hit) =>
    limit(async (): Promise<TcgapiCardShape> => {
      try {
        const setMeta = await c.pkmncardsClient.getSetMetaByCode(hit.setCode);
        if (!setMeta) return degradedShape(hit);

        // Look up the pkmnprices set id via cached set list. We cache the
        // full list under this client instance for the lifetime of the
        // request — cheap because the SDK page walk is memoized.
        const setId = await resolvePkmnpricesSetId(pricesClient, setMeta.name);
        if (setId == null) return degradedShape(hit);

        const page = await pricesClient.searchCards({ set_id: setId, number: hit.number });
        const match = pickBestMatch(page.results, hit);
        if (!match) return degradedShape(hit);
        return mapCardToTcgapiShape(match, hit);
      } catch {
        return degradedShape(hit);
      }
    }),
  );

  const results = await Promise.all(tasks);
  // Drop obvious duplicates (same id) — pkmncards occasionally lists a card
  // under both a promo and a mainline printing.
  const seenIds = new Set<string>();
  return results.filter((row) => {
    if (row.id === '' ) return true;
    if (seenIds.has(row.id)) return false;
    seenIds.add(row.id);
    return true;
  });
}

/**
 * Cache pkmnprices set-name → id lookups per pricesClient instance. Each
 * hydration batch reuses the same singleton client, so this memo lives just
 * for the batch. We normalize both sides so `"Pokémon GO"` and `"Pokemon GO"`
 * match without a bespoke unicode dance.
 */
const setIdMemo = new WeakMap<object, Map<string, number>>();
async function resolvePkmnpricesSetId(
  pricesClient: Awaited<ReturnType<Container['pkmnpricesFor']>>,
  setName: string,
): Promise<number | null> {
  let memo = setIdMemo.get(pricesClient);
  if (!memo) {
    const rows = await pricesClient.listAllSets();
    memo = new Map();
    for (const row of rows) {
      memo.set(normalizeSetName(row.name), row.id);
    }
    setIdMemo.set(pricesClient, memo);
  }
  return memo.get(normalizeSetName(setName)) ?? null;
}

function normalizeSetName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * When multiple cards share (set_id, number) — usually a reverse-holo or
 * alternate print — prefer the one whose name matches the pkmncards slug.
 * Falls back to the first result so we never drop data.
 */
function pickBestMatch(
  candidates: PkmnpricesCardSummary[],
  hit: ArtistCardHit,
): PkmnpricesCardSummary | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const nameSlug = hit.nameSlug.toLowerCase();
  const exact = candidates.find((c) => nameSlugFromCardName(c.name) === nameSlug);
  return exact ?? candidates[0];
}

function nameSlugFromCardName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function mapCardToTcgapiShape(c: PkmnpricesCardSummary, hit: ArtistCardHit): TcgapiCardShape {
  return {
    id: String(c.id),
    name: c.name,
    number: c.number ?? hit.number,
    rarity: c.rarity,
    imageUrl: c.imageUrl,
    setId: c.setId != null ? String(c.setId) : null,
    setName: c.setName,
    artist: c.artist ?? null,
    gameSlug: 'pokemon',
    gameName: 'Pokémon',
  };
}

/**
 * Fallback shape when we can't fully hydrate. The id is intentionally left
 * blank so the UI can either skip pricing or attempt a manual lookup — the
 * card is still shown so the operator can see what artist search returned.
 */
function degradedShape(hit: ArtistCardHit): TcgapiCardShape {
  return {
    id: '',
    name: hit.displayName,
    number: hit.number,
    rarity: null,
    imageUrl: null,
    setId: null,
    setName: null,
    artist: null,
    gameSlug: 'pokemon',
    gameName: 'Pokémon',
  };
}
