/**
 * Minimal client for TCGapi.dev — the MVP's single source for catalog,
 * pricing, and image URLs across all supported games.
 *
 * The exact endpoint surface should be reconciled with the latest TCGapi.dev
 * docs before going to production; the methods here cover the operations the
 * rest of the codebase actually needs:
 *
 *   - searchProducts(query, opts)
 *   - getProduct(productId)
 *   - getPricing(productIds[])
 *   - imageUrl(productId)
 *
 * Auth is via the `Authorization: ****** header when a key is
 * configured; anonymous requests still work for catalog reads in
 * development.
 */
import { loadEnv } from '../../config/env';

export interface TcgapiProduct {
  id: string;
  game: string;
  name: string;
  setName?: string | null;
  cardNumber?: string | null;
  rarity?: string | null;
  imageUrl?: string | null;
  attributes?: Record<string, unknown>;
}

export interface TcgapiPriceRow {
  productId: string;
  marketCents?: number | null;
  lowCents?: number | null;
  midCents?: number | null;
  highCents?: number | null;
  capturedAt: string; // ISO
}

export interface TcgapiSearchResponse {
  results: TcgapiProduct[];
  nextCursor?: string | null;
}

export interface TcgapiPriceResponse {
  prices: TcgapiPriceRow[];
}

export class TcgapiClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(env = loadEnv()) {
    this.baseUrl = env.TCGAPI_BASE_URL.replace(/\/$/, '');
    this.apiKey = env.TCGAPI_KEY;
  }

  async searchProducts(
    query: string,
    opts: { game?: string; cursor?: string; limit?: number } = {},
  ): Promise<TcgapiSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (opts.game) params.set('game', opts.game);
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.limit) params.set('limit', String(opts.limit));
    return this.get<TcgapiSearchResponse>(`/v1/products?${params.toString()}`);
  }

  async getProduct(productId: string): Promise<TcgapiProduct> {
    return this.get<TcgapiProduct>(`/v1/products/${encodeURIComponent(productId)}`);
  }

  async getPricing(productIds: string[]): Promise<TcgapiPriceResponse> {
    if (productIds.length === 0) return { prices: [] };
    const params = new URLSearchParams({ ids: productIds.join(',') });
    return this.get<TcgapiPriceResponse>(`/v1/prices?${params.toString()}`);
  }

  imageUrl(productId: string): string {
    return `${this.baseUrl}/v1/products/${encodeURIComponent(productId)}/image`;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`tcgapi ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) h['authorization'] = 'Bearer ' + this.apiKey;
    return h;
  }
}
