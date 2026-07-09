/**
 * Per-store proxy in front of the PkmnPrices.com API. Mirrors the shape of
 * `/tcgapi/*` so the Trade-In UI can swap URLs with minimal changes:
 *   GET /pkmnprices/sets?language=english      → { sets: SetRow[] }
 *   GET /pkmnprices/search?q=&setId=&language= → { results: TcgapiCard[] ... }
 *   GET /pkmnprices/cards/:id/prices           → { cardId, prices: PriceRow[] }
 *
 * Caching:
 *   - Search queries and set listings are cached in-process for 15 min in an
 *     LRU (max 500 keys). Two operators typing the same partial name inside
 *     that window costs one upstream credit, not two.
 *   - Card price rows are cached for 5 min: short enough that a nightly
 *     refresh will still see fresh prices, but long enough to absorb an
 *     operator paging in the results list.
 */
import { Router } from 'express';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest } from '../../common/http-errors';
import {
  pickBestTcgplayerPrice,
  type PkmnpricesCardSummary,
  type PkmnpricesPrice,
} from '../../integrations/pkmnprices/client';
import { requireAuth } from '../auth/middleware';
import type { Container } from '../container';

// --- Response shapes (match the tcgapi proxy so the web can swap URLs) ---

interface TcgapiCardShape {
  id: string;
  name: string;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  setId: string | null;
  setName: string | null;
  gameSlug: 'pokemon';
  gameName: 'Pokémon';
}

interface PriceRowShape {
  cardId: string;
  printing: string;
  marketCents: number | null;
  lowCents: number | null;
  medianCents: number | null;
  buylistCents: number | null;
  lastUpdatedAt: string | null;
}

// --- Query schemas -------------------------------------------------------

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  setId: z.coerce.number().int().positive().optional(),
  number: z.string().trim().min(1).max(32).optional(),
  language: z.string().trim().min(1).max(32).optional(),
  currency: z.string().trim().toLowerCase().optional(),
  page: z.coerce.number().int().positive().max(50).optional(),
  perPage: z.coerce.number().int().positive().max(100).optional(),
});

const SetsQuery = z.object({
  language: z.string().trim().min(1).max(32).optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

// --- Caches (module-scoped so they survive container rebuilds) -----------

const searchCache = new LRUCache<string, { body: unknown; expiresAt: number }>({ max: 500 });
const setsCache = new LRUCache<string, { body: unknown; expiresAt: number }>({ max: 100 });
const pricesCache = new LRUCache<string, { body: unknown; expiresAt: number }>({ max: 500 });

const SEARCH_TTL_MS = 15 * 60_000;
const SETS_TTL_MS = 24 * 60 * 60_000;
const PRICES_TTL_MS = 5 * 60_000;

function cacheGet<T>(cache: LRUCache<string, { body: unknown; expiresAt: number }>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.body as T;
}

function cacheSet(
  cache: LRUCache<string, { body: unknown; expiresAt: number }>,
  key: string,
  body: unknown,
  ttlMs: number,
): void {
  cache.set(key, { body, expiresAt: Date.now() + ttlMs });
}

// --- Router --------------------------------------------------------------

export function pkmnpricesRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/sets',
    asyncHandler(async (req, res) => {
      const parsed = SetsQuery.safeParse(req.query);
      if (!parsed.success) throw BadRequest('invalid sets params', parsed.error.flatten());
      const status = await c.configs.getPkmnpricesStatus(req.user!.storeId);
      if (!status.configured || !status.hasKey) {
        throw BadRequest('PkmnPrices.com is not configured for this store.');
      }

      // pkmnprices treats missing language as "any" and returns zero sets
      // when we explicitly pin the default 'english' value (English sets in
      // the upstream catalog aren't tagged with a language string). Drop the
      // filter for the default language so the operator gets every set.
      const effectiveLanguage =
        parsed.data.language && parsed.data.language.toLowerCase() !== 'english'
          ? parsed.data.language
          : undefined;

      const cacheKey = `${req.user!.storeId}|sets|${effectiveLanguage ?? ''}|${parsed.data.q ?? ''}`;
      const cached = cacheGet<{ sets: Array<{ id: string; name: string }> }>(setsCache, cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const client = await c.pkmnpricesFor(req.user!.storeId);
      // Fetch every set (paginated on the SDK side). The trade UI's set
      // inference needs the full list — a 50-row cap silently breaks it.
      const rows = await client.listAllSets({
        language: effectiveLanguage,
        name: parsed.data.q,
      });
      const body = {
        sets: rows.map((s) => ({ id: String(s.id), name: s.name })),
      };
      cacheSet(setsCache, cacheKey, body, SETS_TTL_MS);
      res.json(body);
    }),
  );

  r.get(
    '/search',
    asyncHandler(async (req, res) => {
      const parsed = SearchQuery.safeParse(req.query);
      if (!parsed.success) throw BadRequest('invalid search params', parsed.error.flatten());
      const { q, setId, number, language, currency } = parsed.data;
      const perPage = parsed.data.perPage ?? 24;
      const page = parsed.data.page ?? 1;

      if (!q && !setId && !number) {
        throw BadRequest('Provide a search term, a set, or a card number.');
      }

      const status = await c.configs.getPkmnpricesStatus(req.user!.storeId);
      if (!status.configured || !status.hasKey) {
        throw BadRequest('PkmnPrices.com is not configured for this store.');
      }
      // Tier-aware currency gating: Free tier gets USD only.
      if (status.tier === 'free' && currency === 'eur') {
        throw BadRequest('EUR prices require Pro tier or higher.');
      }
      // Pass currency filter to API; Free tier defaults to USD.
      const apiCurrency = status.tier === 'free' ? 'usd' : currency ?? undefined;

      // pkmnprices returns zero results when we explicitly pin the default
      // 'english' language, because English cards in the upstream catalog
      // aren't tagged with a language string. Treat 'english' as "no filter".
      const effectiveLanguage =
        language && language.toLowerCase() !== 'english' ? language : undefined;

      const cacheKey = `${req.user!.storeId}|search|${q ?? ''}|${setId ?? ''}|${number ?? ''}|${effectiveLanguage ?? ''}|${apiCurrency ?? ''}|${page}|${perPage}`;
      const cached = cacheGet<{ results: TcgapiCardShape[] }>(searchCache, cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const client = await c.pkmnpricesFor(req.user!.storeId);
      const apiPage = await client.searchCards({
        name: q,
        set_id: setId,
        number,
        language: effectiveLanguage,
        currency: apiCurrency as any,
        page,
        per_page: perPage,
      });

      const results = apiPage.results.map(mapCardToTcgapiShape);
      const body = {
        results,
        page: apiPage.page,
        perPage: apiPage.perPage,
        hasMore: apiPage.page * apiPage.perPage < apiPage.total,
        total: apiPage.total,
      };
      cacheSet(searchCache, cacheKey, body, SEARCH_TTL_MS);
      res.json(body);
    }),
  );

  r.get(
    '/cards/:id/prices',
    asyncHandler(async (req, res) => {
      const cardId = Number(req.params.id);
      if (!Number.isFinite(cardId) || cardId <= 0) throw BadRequest('invalid card id');

      const status = await c.configs.getPkmnpricesStatus(req.user!.storeId);
      if (!status.configured || !status.hasKey) {
        throw BadRequest('PkmnPrices.com is not configured for this store.');
      }
      // Free tier gets USD only; Pro/Business can request either currency.
      const apiCurrency = status.tier === 'free' ? 'usd' : undefined;

      const cacheKey = `${req.user!.storeId}|prices|${cardId}|${apiCurrency ?? ''}`;
      const cached = cacheGet<{ prices: PriceRowShape[] }>(pricesCache, cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const client = await c.pkmnpricesFor(req.user!.storeId);
      const card = await client.getCard(cardId, { currency: apiCurrency as any });
      const prices = groupPricesByPrinting(String(cardId), card.prices);
      const body = { cardId: String(cardId), prices };
      cacheSet(pricesCache, cacheKey, body, PRICES_TTL_MS);
      res.json(body);
    }),
  );

  return r;
}

// --- Mappers -------------------------------------------------------------

function mapCardToTcgapiShape(c: PkmnpricesCardSummary): TcgapiCardShape {
  return {
    id: String(c.id),
    name: c.name,
    number: c.number,
    rarity: c.rarity,
    imageUrl: c.imageUrl,
    setId: c.setId != null ? String(c.setId) : null,
    setName: c.setName,
    gameSlug: 'pokemon',
    gameName: 'Pokémon',
  };
}

/**
 * PkmnPrices returns one price row per (source, condition, variant); the
 * Trade-In UI expects one row per printing. Collapse variants (Normal /
 * Reverse / Holofoil) into `printing` and take TCGplayer's Near Mint row for
 * the market/low/median where possible.
 */
function groupPricesByPrinting(cardId: string, prices: PkmnpricesPrice[]): PriceRowShape[] {
  const printings = new Set<string>();
  for (const p of prices) {
    printings.add(normalizePrinting(p.variant));
  }
  if (printings.size === 0) printings.add('Normal');

  return Array.from(printings).map((printing) => {
    const best = pickBestTcgplayerPrice(prices, { condition: 'NM', printing });
    return {
      cardId,
      printing,
      marketCents: best?.marketCents ?? null,
      // Pkmnprices doesn't expose "low"/"median" separately — set them to
      // market so the trade-in payout math still works.
      lowCents: best?.marketCents ?? null,
      medianCents: best?.marketCents ?? null,
      buylistCents: null,
      lastUpdatedAt: best?.capturedAt ?? null,
    };
  });
}

function normalizePrinting(variant: string | null): string {
  const v = (variant ?? '').toLowerCase();
  if (v.includes('reverse')) return 'Reverse';
  if (v.includes('holo')) return 'Holo';
  if (v.includes('foil')) return 'Foil';
  if (v.includes('1st') || v.includes('first')) return 'FirstEdition';
  return 'Normal';
}
