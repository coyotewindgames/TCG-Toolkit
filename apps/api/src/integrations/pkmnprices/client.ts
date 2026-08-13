/**
 * Per-store client for the PkmnPrices.com API. Wraps the official
 * `@pkmnprices/sdk` so the rest of the app deals in integer cents (matches
 * every other money type in the schema) and gets a consistent logger surface.
 *
 * Why wrap the SDK at all:
 *  - SDK returns dollars as floats — we store cents, everywhere.
 *  - SDK types are already good, but we want a `PkmnPricesClient` with a stable
 *    in-house shape the pricing router can depend on.
 *  - We inject a per-request pino log line with `{ source, endpoint, durationMs,
 *    creditsCharged }` so the nightly job's credit budget stays observable.
 */
import {
  PkmnPrices,
  PkmnPricesError,
  type Card as SdkCard,
  type CardSummary as SdkCardSummary,
  type CurrencyFilter,
  type EbayListing as SdkEbayListing,
  type EbayListingsParams,
  type ListCardsParams,
  type ListSetsParams,
  type Price as SdkPrice,
  type Set as SdkSet,
} from '@pkmnprices/sdk';
import { getLogger } from '../../common/logger';
import { TooManyRequests } from '../../common/http-errors';

// ---- Domain types (money in cents) ----------------------------------------

export interface PkmnpricesCardSummary {
  id: number;
  name: string;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  tcgplayerId: number | null;
  setId: number | null;
  setName: string | null;
  language?: string | null;
  artist?: string | null;
}

export interface PkmnpricesPrice {
  source: 'tcgplayer' | 'ebay' | 'cardmarket';
  currency: 'USD' | 'EUR';
  condition: string | null;
  variant: string | null;
  marketCents: number;
  capturedAt: string;
}

export interface PkmnpricesCard extends PkmnpricesCardSummary {
  prices: PkmnpricesPrice[];
}

/**
 * A single eBay sold comp for a card, from PkmnPrices'
 * `GET /v1/cards/:id/listings/ebay` (PriceCharting-sourced, USD). Money in cents.
 * `grader`/`grade` are populated for slabbed sales, null for raw.
 */
export interface PkmnpricesEbaySale {
  priceCents: number;
  grader: string | null;
  grade: string | null;
  saleType: string;
  soldAt: string;
  title: string;
  listingUrl: string;
}

export interface PkmnpricesSet {
  id: number;
  name: string;
  language: string;
  cardCount: number;
  tcgplayerId: number | null;
}

export interface PkmnpricesPage<T> {
  results: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface PkmnpricesClientConfig {
  apiKey: string;
  maxRetries?: number;
  timeoutMs?: number;
}

// ---- Client ---------------------------------------------------------------

export class PkmnPricesClient {
  private readonly sdk: PkmnPrices;
  private readonly log = getLogger();

  constructor(config: PkmnpricesClientConfig) {
    this.sdk = new PkmnPrices({
      apiKey: config.apiKey,
      maxRetries: config.maxRetries ?? 3,
      timeoutMs: config.timeoutMs ?? 15_000,
    });
  }

  // ---- Cards --------------------------------------------------------------

  async searchCards(
    params: ListCardsParams & { artist?: string },
  ): Promise<PkmnpricesPage<PkmnpricesCardSummary>> {
    const started = Date.now();
    try {
      // Artist is not in the SDK's typed param list, but the underlying HTTP
      // client forwards unknown keys as query params. Cast so TS doesn't
      // complain.
      const res = await this.sdk.cards.list(params as ListCardsParams);
      this.log.info(
        {
          source: 'pkmnprices',
          endpoint: 'cards.list',
          durationMs: Date.now() - started,
          params: {
            name: params.name,
            language: params.language,
            set_id: params.set_id,
            artist: params.artist,
          },
          total: res.pagination.total,
        },
        'pkmnprices search',
      );
      return {
        results: res.data.map(mapSummary),
        page: res.pagination.page,
        perPage: res.pagination.per_page,
        total: res.pagination.total,
        totalPages: res.pagination.total_pages,
      };
    } catch (err) {
      this.rethrowSdkError('cards.list', started, err);
    }
  }

  async getCard(id: number, opts: { currency?: CurrencyFilter } = {}): Promise<PkmnpricesCard> {
    const started = Date.now();
    try {
      const card = await this.sdk.cards.get(id, { currency: opts.currency });
      this.log.debug(
        {
          source: 'pkmnprices',
          endpoint: 'cards.get',
          cardId: id,
          durationMs: Date.now() - started,
          priceRows: card.prices.length,
        },
        'pkmnprices card',
      );
      return mapCard(card);
    } catch (err) {
      this.rethrowSdkError('cards.get', started, err, { cardId: id });
    }
  }

  /** Convenience: just the price array (already in cents). */
  async getCardPrices(id: number, opts: { currency?: CurrencyFilter } = {}): Promise<PkmnpricesPrice[]> {
    const card = await this.getCard(id, opts);
    return card.prices;
  }

  /**
   * Recent eBay sold comps for a card, filtered to a grading company + grade.
   * Cursor-paginated upstream (max 20/page, 1 credit per item returned), so we
   * cap collection at `maxItems` and stop once sales fall outside `sinceDays`.
   * Used by the pricing router to build a graded-card median.
   */
  async getGradedEbaySales(
    cardId: number,
    opts: { grader: string; grade: string; sinceDays?: number; maxItems?: number },
  ): Promise<PkmnpricesEbaySale[]> {
    const started = Date.now();
    const maxItems = opts.maxItems ?? 40;
    const cutoffMs =
      opts.sinceDays != null ? Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000 : null;
    const params: EbayListingsParams = {
      grader: opts.grader,
      grade: opts.grade,
      sort: 'date_desc',
      limit: 20,
    };
    const sales: PkmnpricesEbaySale[] = [];
    try {
      for await (const listing of this.sdk.cards.listings.iterateEbay(cardId, params)) {
        if (cutoffMs != null && Date.parse(listing.sold_at) < cutoffMs) break;
        sales.push(mapEbaySale(listing));
        if (sales.length >= maxItems) break;
      }
      this.log.debug(
        {
          source: 'pkmnprices',
          endpoint: 'cards.listings.ebay',
          cardId,
          grader: opts.grader,
          grade: opts.grade,
          durationMs: Date.now() - started,
          sales: sales.length,
        },
        'pkmnprices graded ebay sales',
      );
      return sales;
    } catch (err) {
      this.rethrowSdkError('cards.listings.ebay', started, err, { cardId });
    }
  }

  // ---- Sets ---------------------------------------------------------------

  async listSets(params: ListSetsParams = {}): Promise<PkmnpricesPage<PkmnpricesSet>> {
    const started = Date.now();
    try {
      const res = await this.sdk.sets.list(params);
      this.log.debug(
        {
          source: 'pkmnprices',
          endpoint: 'sets.list',
          durationMs: Date.now() - started,
          total: res.pagination.total,
        },
        'pkmnprices sets',
      );
      return {
        results: res.data.map(mapSet),
        page: res.pagination.page,
        perPage: res.pagination.per_page,
        total: res.pagination.total,
        totalPages: res.pagination.total_pages,
      };
    } catch (err) {
      this.rethrowSdkError('sets.list', started, err);
    }
  }

  /**
   * Fetch every set (across all pages). Used by the transactions UI so the
   * client can offer inference like "Rayquaza Evolving Skies" → set = Evolving
   * Skies even when the set isn't in the first page of results.
   */
  async listAllSets(params: ListSetsParams = {}): Promise<PkmnpricesSet[]> {
    const started = Date.now();
    try {
      const rows = await this.sdk.sets.listAll(params);
      this.log.debug(
        {
          source: 'pkmnprices',
          endpoint: 'sets.listAll',
          durationMs: Date.now() - started,
          total: rows.length,
        },
        'pkmnprices sets all',
      );
      return rows.map(mapSet);
    } catch (err) {
      this.rethrowSdkError('sets.listAll', started, err);
    }
  }

  // ---- Helpers ------------------------------------------------------------

  /**
   * Log the SDK error and return a well-typed error to throw.
   *
   * 429 rate-limit responses are converted to `HttpError(429)` so the global
   * error middleware returns a proper `Retry-After` response instead of a
   * generic 500. All other SDK errors are re-thrown as-is (the middleware
   * duck-types any `.status === 429` fallback, but converting here gives us
   * the `retryAfterMs` detail we already have in scope).
   */
  private rethrowSdkError(endpoint: string, started: number, err: unknown, extras: Record<string, unknown> = {}): never {
    const durationMs = Date.now() - started;
    if (err instanceof PkmnPricesError) {
      this.log.warn(
        {
          source: 'pkmnprices',
          endpoint,
          durationMs,
          status: err.status,
          code: err.code,
          rateLimit: err.rateLimit,
          retryAfterMs: err.retryAfterMs,
          ...extras,
        },
        `pkmnprices error: ${err.message}`,
      );
      if (err.status === 429) {
        throw TooManyRequests(err.message ?? 'per-minute rate limit exceeded', err.retryAfterMs ?? undefined);
      }
    } else {
      this.log.error(
        { source: 'pkmnprices', endpoint, durationMs, err: (err as Error)?.message, ...extras },
        'pkmnprices unknown error',
      );
    }
    throw err;
  }
}

// ---- Mapping helpers ------------------------------------------------------

function mapSummary(s: SdkCardSummary): PkmnpricesCardSummary {
  return {
    id: s.id,
    name: s.name,
    number: s.number,
    rarity: s.rarity,
    imageUrl: s.image_url,
    tcgplayerId: s.tcg_player_id ?? null,
    setId: s.set?.id ?? null,
    setName: s.set?.name ?? null,
    // Not in the SDK type; the upstream API returns it on card summaries and
    // we forward it for artist search + display.
    artist: (s as unknown as { artist?: string | null }).artist ?? null,
  };
}

function mapCard(c: SdkCard): PkmnpricesCard {
  return {
    ...mapSummary(c),
    prices: c.prices.map(mapPrice),
  };
}

function mapPrice(p: SdkPrice): PkmnpricesPrice {
  return {
    source: p.source,
    currency: p.currency,
    condition: p.condition,
    variant: p.variant,
    marketCents: dollarsToCents(p.market_price),
    capturedAt: p.created_at,
  };
}

function mapSet(s: SdkSet): PkmnpricesSet {
  return {
    id: s.id,
    name: s.name,
    language: s.language,
    cardCount: s.card_count,
    tcgplayerId: s.tcg_player_id ?? null,
  };
}

function dollarsToCents(dollars: number | null | undefined): number {
  if (dollars == null || !Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

function mapEbaySale(l: SdkEbayListing): PkmnpricesEbaySale {
  return {
    priceCents: dollarsToCents(l.price),
    grader: l.grader,
    grade: l.grade,
    saleType: l.sale_type,
    soldAt: l.sold_at,
    title: l.title,
    listingUrl: l.listing_url,
  };
}

/**
 * Median sold price (in cents) from a set of graded eBay comps, dropping gross
 * outliers (>3× the raw median) so a single mis-listed auction can't skew the
 * result. Returns null when the sample is too thin to trust.
 */
export function aggregateGradedMedianCents(
  sales: PkmnpricesEbaySale[],
  opts: { minSample?: number } = {},
): { medianCents: number; sampleSize: number } | null {
  const minSample = opts.minSample ?? 3;
  const prices = sales.map((s) => s.priceCents).filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length < minSample) return null;
  const rawMedian = medianOf(prices);
  if (rawMedian <= 0) return null;
  const trimmed = prices.filter((p) => p <= rawMedian * 3);
  if (trimmed.length < minSample) return null;
  return { medianCents: medianOf(trimmed), sampleSize: trimmed.length };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/** SKU grading-company enum → PriceCharting/eBay grader filter string. */
export function gradingCompanyToGrader(company: string): string {
  switch (company.toLowerCase()) {
    case 'psa':
      return 'PSA';
    case 'cgc':
      return 'CGC';
    case 'beckett':
      return 'BGS';
    case 'sgc':
      return 'SGC';
    case 'tag':
      return 'TAG';
    default:
      return company.toUpperCase();
  }
}

/**
 * From a `prices` array, pick the row that best matches the SKU's condition
 * and printing. Preference order:
 *   1. tcgplayer + exact condition + exact variant
 *   2. tcgplayer + exact condition (any variant)
 *   3. tcgplayer + any condition (first row)
 *   4. any source (first row) — usually cardmarket EUR
 */
export function pickBestTcgplayerPrice(
  prices: PkmnpricesPrice[],
  opts: { condition?: string; printing?: string } = {},
): PkmnpricesPrice | null {
  if (prices.length === 0) return null;
  const tcg = prices.filter((p) => p.source === 'tcgplayer');
  const condition = opts.condition?.toLowerCase();
  const variant = opts.printing?.toLowerCase();

  if (tcg.length > 0) {
    if (condition && variant) {
      const exact = tcg.find(
        (p) =>
          p.condition?.toLowerCase() === condition &&
          p.variant?.toLowerCase().includes(variant),
      );
      if (exact) return exact;
    }
    if (condition) {
      const byCondition = tcg.find((p) => p.condition?.toLowerCase() === condition);
      if (byCondition) return byCondition;
    }
    return tcg[0];
  }

  return prices[0];
}
