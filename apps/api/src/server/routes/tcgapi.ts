/**
 * Read-only proxy in front of the per-store tcgapi.dev client. Used by the
 * Trade-In / Buy intake form to fuzzy-search cards and pull live market
 * prices without ever exposing the store's API key to the browser.
 *
 * Why proxy at all (vs calling tcgapi from the browser):
 *  - the API key is encrypted in `tcgapi_configs` and only the server can
 *    decrypt it
 *  - we need to scope every call to the caller's `storeId`
 *  - tcgapi's free tier is rate-limited; a server-side bottleneck makes it
 *    easier to add caching later if we need to
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest } from '../../common/http-errors';
import { requireAuth } from '../auth/middleware';
import type { Container } from '../container';
import type { TcgapiCard } from '../../integrations/tcgapi/client';

/**
 * Search params.
 *  - `q` (optional) — name fuzzy-search; if omitted we require a `setId` so
 *    we can browse a whole set instead of returning the entire catalog.
 *  - `game` / `setId` — scope filters passed through to tcgapi.dev.
 *  - `number` — card-number filter (e.g. "025", "025/189", or "XY133"). Matched against
 *    the prefix of the card's `number` field after any "/" is stripped.
 *  - `rarity` — case-insensitive substring filter on the card's rarity.
 */
const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  game: z.string().trim().min(1).max(64).optional(),
  setId: z.string().trim().min(1).max(64).optional(),
  number: z.string().trim().min(1).max(32).optional(),
  rarity: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().positive().max(50).optional(),
  perPage: z.coerce.number().int().positive().max(50).optional(),
});

const TopMoversQuery = z.object({
  direction: z.enum(['up', 'down']).optional(),
  period: z.enum(['24h', '7d', '30d']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  type: z.string().trim().min(1).max(64).optional(),
});

// Pull the card-number portion before any "/" (e.g. "025/189" -> "025") and
// normalize common formatting differences so "XY133", "XY 133", and "XY-133"
// can match the same upstream card number.
function normalizeNumber(n: string): string {
  const trimmed = n.trim().toLowerCase();
  const slash = trimmed.indexOf('/');
  const head = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const cleaned = head.replace(/[^a-z0-9]/g, '');
  if (!cleaned) return '0';
  return cleaned.replace(/^0+/, '').replace(/([a-z])0+(\d)/g, '$1$2') || '0';
}

function numberMatches(cardNumber: string | null, needle: string): boolean {
  if (!cardNumber) return false;
  const a = normalizeNumber(cardNumber);
  const b = normalizeNumber(needle);
  return a === b || a.startsWith(b);
}

export function tcgapiRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/games',
    asyncHandler(async (req, res) => {
      const status = await c.configs.getTcgapiStatus(req.user!.storeId);
      if (!status.configured || !status.hasKey) {
        throw BadRequest(
          'TCGapi.dev is not configured for this store. Add an API key in Settings → Integrations.',
        );
      }
      const client = await c.tcgapiFor(req.user!.storeId);
      const page = await client.listGames({ perPage: 50 });
      res.json(page);
    }),
  );

  r.get(
    '/games/:slug/sets',
    asyncHandler(async (req, res) => {
      const status = await c.configs.getTcgapiStatus(req.user!.storeId);
      if (!status.configured || !status.hasKey) {
        throw BadRequest('TCGapi.dev is not configured for this store.');
      }
      const client = await c.tcgapiFor(req.user!.storeId);
      const sets = await client.listSetsByGame(req.params.slug);
      res.json({ sets });
    }),
  );

  r.get(
    '/search',
    asyncHandler(async (req, res) => {
      const parsed = SearchQuery.safeParse(req.query);
      if (!parsed.success) throw BadRequest('invalid search params', parsed.error.flatten());
      const { q, game, setId, number, rarity } = parsed.data;
      const perPage = parsed.data.perPage ?? 24;
      const page = parsed.data.page ?? 1;

      // Need at least one of: q, setId, or (number scoped to a set/game)
      if (!q && !setId && !number) {
        throw BadRequest(
          'Provide a search term, a set, or a card number (with a set or game scope).',
        );
      }

      const status = await c.configs.getTcgapiStatus(req.user!.storeId);
      if (!status.configured || !status.hasKey) {
        throw BadRequest(
          'TCGapi.dev is not configured for this store. Add an API key in Settings → Integrations.',
        );
      }
      const client = await c.tcgapiFor(req.user!.storeId);
      const queryGameSlugs = game ? [game] : status.queryGameSlugs;

      // Number search (or browsing a whole set): walk the set, then filter
      // locally. This is much friendlier on the free tier than firing one
      // search per card and gives us reliable #number lookup.
      if (setId && (number || !q)) {
        const all = await client.listCardsInSet(setId);
        const filtered = applyClientFilters(all, { q, number, rarity });
        const start = (page - 1) * perPage;
        const slice = filtered.slice(start, start + perPage);
        res.json({
          results: slice,
          page,
          perPage,
          hasMore: start + perPage < filtered.length,
          total: filtered.length,
        });
        return;
      }

      // Otherwise hit the API's name search and post-filter rarity/number
      // locally on the returned page.
      if (queryGameSlugs.length > 1) {
        const upstreamPerPage = Math.min(50, page * perPage);
        const pages = await Promise.all(
          queryGameSlugs.map((gameSlug) =>
            client.search({
              q: q ?? (number ?? ''),
              game: gameSlug,
              setId,
              page: 1,
              perPage: upstreamPerPage,
            }),
          ),
        );
        const merged = dedupeCards(
          pages.flatMap((apiPage) => applyClientFilters(apiPage.results, { number, rarity })),
        );
        const start = (page - 1) * perPage;
        res.json({
          results: merged.slice(start, start + perPage),
          page,
          perPage,
          hasMore: start + perPage < merged.length,
          total: merged.length,
        });
        return;
      }

      const apiPage = await client.search({
        q: q ?? (number ?? ''),
        game: queryGameSlugs[0],
        setId,
        page,
        perPage,
      });
      const filtered = applyClientFilters(apiPage.results, { number, rarity });
      res.json({ ...apiPage, results: filtered });
    }),
  );

  r.get(
    '/cards/:id/prices',
    asyncHandler(async (req, res) => {
      const status = await c.configs.getTcgapiStatus(req.user!.storeId);
      if (!status.configured || !status.hasKey) {
        throw BadRequest('TCGapi.dev is not configured for this store.');
      }
      const client = await c.tcgapiFor(req.user!.storeId);
      const rows = await client.getCardPrices(req.params.id);
      res.json({ cardId: req.params.id, prices: rows });
    }),
  );

  r.get(
    '/prices/top-movers',
    asyncHandler(async (req, res) => {
      const parsed = TopMoversQuery.safeParse(req.query);
      if (!parsed.success) {
        throw BadRequest('invalid top movers params', parsed.error.flatten());
      }
      const status = await c.configs.getTcgapiStatus(req.user!.storeId);
      if (!status.configured || !status.hasKey) {
        throw BadRequest('TCGapi.dev is not configured for this store.');
      }
      const client = await c.tcgapiFor(req.user!.storeId);
      const rows = await client.getTopMovers(parsed.data);
      res.json({ data: rows });
    }),
  );

  return r;
}

function applyClientFilters(
  cards: TcgapiCard[],
  opts: { q?: string; number?: string; rarity?: string },
): TcgapiCard[] {
  let out = cards;
  if (opts.q) {
    const needle = opts.q.toLowerCase();
    out = out.filter((c) => c.name.toLowerCase().includes(needle));
  }
  if (opts.number) {
    out = out.filter((c) => numberMatches(c.number, opts.number!));
  }
  if (opts.rarity) {
    const needle = opts.rarity.toLowerCase();
    out = out.filter((c) => (c.rarity ?? '').toLowerCase().includes(needle));
  }
  return out;
}

function dedupeCards(cards: TcgapiCard[]): TcgapiCard[] {
  const seen = new Set<string>();
  const out: TcgapiCard[] = [];
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    out.push(card);
  }
  return out;
}
