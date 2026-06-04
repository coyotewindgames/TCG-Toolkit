/**
 * Client for tcgapi.dev — the exclusive source for card catalog, pricing,
 * and images.
 *
 * Real API contract (per https://tcgapi.dev/api-explorer/):
 *   - Base URL:    https://api.tcgapi.dev/v1
 *   - Auth:        X-API-Key header, format `tcg_live_xxxxxxxx`
 *   - Envelope:    { data, meta? } on all responses
 *   - Prices:      returned in **dollars** per printing variant; this client
 *                  converts to integer cents at the boundary so the rest of
 *                  the app only deals with cents.
 *   - Pagination:  page / per_page / meta.has_more
 *
 * Only the endpoints the rest of the codebase actually uses are exposed.
 */

// ---- Wire-format types (mirror the API's snake_case payload) ---------------

interface TcgapiEnvelope<T> {
  data: T;
  meta?: { total?: number; page?: number; per_page?: number; has_more?: boolean };
}

interface TcgapiCardWire {
  id: number | string;
  name: string;
  clean_name?: string | null;
  number?: string | null;
  rarity?: string | null;
  image_url?: string | null;
  tcgplayer_id?: number | string | null;
  tcgplayer_url?: string | null;
  product_type?: string | null;
  foil_only?: number | null;
  set_id?: number | string | null;
  set_name?: string | null;
  game_id?: number | string | null;
  game_name?: string | null;
  game_slug?: string | null;
  custom_attributes?: Record<string, unknown> | null;
}

interface TcgapiPriceWire {
  card_id?: number | string;
  printing: string;
  market_price?: number | null;
  low_price?: number | null;
  median_price?: number | null;
  lowest_with_shipping?: number | null;
  buylist_price?: number | null;
  price_change_24h?: number | null;
  last_updated_at?: string | null;
}

// ---- Domain types (camelCase, prices in cents) ----------------------------

export interface TcgapiCard {
  id: string;
  name: string;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  tcgplayerId: string | null;
  setId: string | null;
  setName: string | null;
  gameSlug: string | null;
  gameName: string | null;
}

export interface TcgapiPriceRow {
  cardId: string;
  printing: string;
  marketCents: number | null;
  lowCents: number | null;
  medianCents: number | null;
  buylistCents: number | null;
  lastUpdatedAt: string | null;
}

export interface TcgapiGame {
  id: string;
  name: string;
  slug: string;
}

export interface TcgapiSet {
  id: string;
  name: string;
  slug?: string;
}

export interface TcgapiPage<T> {
  results: T[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total: number | null;
}

// ---- Client ---------------------------------------------------------------

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface TcgapiClientConfig {
  baseUrl: string;
  apiKey: string;
}

export class TcgapiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: TcgapiClientConfig) {
    const raw = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.baseUrl = /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
    this.apiKey = config.apiKey;
  }

  // ---- Catalog reads ------------------------------------------------------

  async search(opts: {
    q: string;
    game?: string;
    setId?: string;
    page?: number;
    perPage?: number;
  }): Promise<TcgapiPage<TcgapiCard>> {
    const params = new URLSearchParams({ q: opts.q });
    if (opts.game) params.set('game', opts.game);
    if (opts.setId) params.set('set_id', opts.setId);
    if (opts.page) params.set('page', String(opts.page));
    if (opts.perPage) params.set('per_page', String(opts.perPage));
    const body = await this.get<TcgapiEnvelope<TcgapiCardWire[]>>(`/search?${params.toString()}`);
    return this.mapPage(body, mapCard);
  }

  async getCard(cardId: string): Promise<TcgapiCard> {
    const body = await this.get<TcgapiEnvelope<TcgapiCardWire>>(
      `/cards/${encodeURIComponent(cardId)}`,
    );
    return mapCard(body.data);
  }

  async getCardByTcgplayerId(tcgplayerId: string): Promise<TcgapiCard> {
    const body = await this.get<TcgapiEnvelope<TcgapiCardWire>>(
      `/cards/tcgplayer/${encodeURIComponent(tcgplayerId)}`,
    );
    return mapCard(body.data);
  }

  /**
   * Returns one row per printing variant for the card. If `printing` is
   * given, the API filters server-side.
   */
  async getCardPrices(
    cardId: string,
    opts: { printing?: string } = {},
  ): Promise<TcgapiPriceRow[]> {
    const params = new URLSearchParams();
    if (opts.printing) params.set('printing', opts.printing);
    const path = `/cards/${encodeURIComponent(cardId)}/prices${
      params.toString() ? `?${params.toString()}` : ''
    }`;
    const body = await this.get<TcgapiEnvelope<TcgapiPriceWire | TcgapiPriceWire[]>>(path);
    const rows = Array.isArray(body.data) ? body.data : [body.data];
    return rows.map((r) => mapPrice(r, cardId));
  }

  async listGames(opts: { page?: number; perPage?: number } = {}): Promise<TcgapiPage<TcgapiGame>> {
    const params = new URLSearchParams();
    if (opts.page) params.set('page', String(opts.page));
    if (opts.perPage) params.set('per_page', String(opts.perPage));
    const path = `/games${params.toString() ? `?${params.toString()}` : ''}`;
    const body = await this.get<
      TcgapiEnvelope<Array<{ id: number | string; name: string; slug: string }>>
    >(path);
    return this.mapPage(body, (g) => ({ id: String(g.id), name: g.name, slug: g.slug }));
  }

  async listSetsByGame(gameSlug: string): Promise<TcgapiSet[]> {
    const all: TcgapiSet[] = [];
    let page = 1;
    while (page <= 20) {
      const body = await this.get<
        TcgapiEnvelope<Array<{ id: number | string; name: string; slug?: string }>>
      >(`/games/${encodeURIComponent(gameSlug)}/sets?page=${page}&per_page=100`);
      for (const s of body.data) all.push({ id: String(s.id), name: s.name, slug: s.slug });
      if (!body.meta?.has_more) break;
      page++;
    }
    return all;
  }

  /**
   * Returns every card in a given set, walking all pages. Used to build a
   * local set-card index so we can match by `number` without one search per
   * card (free-tier rate limits are tight).
   */
  async listCardsInSet(setId: string): Promise<TcgapiCard[]> {
    const all: TcgapiCard[] = [];
    let page = 1;
    while (page <= 50) {
      const body = await this.get<TcgapiEnvelope<TcgapiCardWire[]>>(
        `/sets/${encodeURIComponent(setId)}/cards?page=${page}&per_page=100`,
      );
      for (const c of body.data) all.push(mapCard(c));
      if (!body.meta?.has_more) break;
      page++;
    }
    return all;
  }

  // ---- HTTP plumbing ------------------------------------------------------

  private mapPage<W, D>(env: TcgapiEnvelope<W[]>, fn: (w: W) => D): TcgapiPage<D> {
    return {
      results: env.data.map(fn),
      page: env.meta?.page ?? 1,
      perPage: env.meta?.per_page ?? env.data.length,
      hasMore: env.meta?.has_more ?? false,
      total: env.meta?.total ?? null,
    };
  }

  private async get<T>(path: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: this.headers(),
        });
      } catch (e) {
        lastErr = e;
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      if (RETRY_STATUSES.has(res.status) && attempt < 3) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new Error(`tcgapi ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
    throw new Error(`tcgapi ${path} failed: ${String(lastErr)}`);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }
}

// ---- Helpers --------------------------------------------------------------

function mapCard(w: TcgapiCardWire): TcgapiCard {
  return {
    id: String(w.id),
    name: w.name,
    number: w.number ?? null,
    rarity: w.rarity ?? null,
    imageUrl: w.image_url ?? null,
    tcgplayerId: w.tcgplayer_id == null ? null : String(w.tcgplayer_id),
    setId: w.set_id == null ? null : String(w.set_id),
    setName: w.set_name ?? null,
    gameSlug: w.game_slug ?? null,
    gameName: w.game_name ?? null,
  };
}

function mapPrice(w: TcgapiPriceWire, cardId: string): TcgapiPriceRow {
  return {
    cardId: w.card_id == null ? cardId : String(w.card_id),
    printing: w.printing,
    marketCents: dollarsToCents(w.market_price),
    lowCents: dollarsToCents(w.low_price),
    medianCents: dollarsToCents(w.median_price),
    buylistCents: dollarsToCents(w.buylist_price),
    lastUpdatedAt: w.last_updated_at ?? null,
  };
}

function dollarsToCents(d: number | null | undefined): number | null {
  if (d == null || !Number.isFinite(d)) return null;
  return Math.round(d * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  return 250 * Math.pow(3, attempt - 1);
}
