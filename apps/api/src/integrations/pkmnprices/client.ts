/**
 * Per-store client for the PkmnPrices.com API. Wraps the official
 * `@pkmnprices/sdk` so the rest of the app deals in integer cents (matches
 * every other money type in the schema) and gets a consistent logger surface.
 *
 * Why wrap the SDK at all:
 *  - SDK returns dollars as floats — we store cents, everywhere.
 *  - SDK types are already good, but we want a `PkmnPricesClient` that mirrors
 *    the shape of `TcgapiClient` so the pricing router can swap them.
 *  - We inject a per-request pino log line with `{ source, endpoint, durationMs,
 *    creditsCharged }` so the nightly job's credit budget stays observable.
 */
import {
  PkmnPrices,
  PkmnPricesError,
  type Card as SdkCard,
  type CardSummary as SdkCardSummary,
  type CurrencyFilter,
  type ListCardsParams,
  type ListSetsParams,
  type Price as SdkPrice,
  type Set as SdkSet,
} from '@pkmnprices/sdk';
import { getLogger } from '../../common/logger';

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
      this.logError('cards.list', started, err);
      throw err;
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
      this.logError('cards.get', started, err, { cardId: id });
      throw err;
    }
  }

  /** Convenience: just the price array (already in cents). */
  async getCardPrices(id: number, opts: { currency?: CurrencyFilter } = {}): Promise<PkmnpricesPrice[]> {
    const card = await this.getCard(id, opts);
    return card.prices;
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
      this.logError('sets.list', started, err);
      throw err;
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
      this.logError('sets.listAll', started, err);
      throw err;
    }
  }

  // ---- Helpers ------------------------------------------------------------

  private logError(endpoint: string, started: number, err: unknown, extras: Record<string, unknown> = {}): void {
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
    } else {
      this.log.error(
        { source: 'pkmnprices', endpoint, durationMs, err: (err as Error)?.message, ...extras },
        'pkmnprices unknown error',
      );
    }
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
