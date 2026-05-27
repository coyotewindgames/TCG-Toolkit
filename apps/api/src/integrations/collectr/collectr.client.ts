import { Injectable } from '@nestjs/common';

/**
 * Minimal Collectr API client. Public Collectr endpoints are not yet
 * universally documented; we treat them as a secondary source for image URLs
 * and binder metadata. Map every Collectr record back to an internal SKU via
 * `(tcgplayer_product_id, condition, printing, language)`.
 */
@Injectable()
export class CollectrClient {
  private readonly baseUrl = process.env.COLLECTR_BASE_URL ?? 'https://api.collectr.app';

  private async request<T>(path: string): Promise<T> {
    const apiKey = process.env.COLLECTR_API_KEY ?? '';
    if (!apiKey) throw new Error('COLLECTR_API_KEY not configured');
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`collectr ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  searchCards(query: string) {
    return this.request<{ results: unknown[] }>(
      `/v1/cards/search?q=${encodeURIComponent(query)}`,
    );
  }

  getInventory() {
    return this.request<{ results: unknown[] }>(`/v1/inventory`);
  }
}
