import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

interface EbayItemSummary {
  price?: { value?: string; currency?: string };
  condition?: string;
  title?: string;
  itemEndDate?: string;
}

/**
 * Tiny eBay Browse API client used to compute rolling sale-price medians.
 *
 * The Browse API requires an application access token (client-credentials
 * OAuth) for the `https://api.ebay.com/oauth/api_scope` scope.
 *
 * Marketplace Insights (which exposes truly *sold* items) requires extra
 * approval. Until that is granted, you can approximate with completed
 * listings filtered by `buyingOptions:{AUCTION}` and `soldItemsOnly:true`.
 */
@Injectable()
export class EbayClient {
  private readonly logger = new Logger(EbayClient.name);
  private readonly baseUrl = process.env.EBAY_BASE_URL ?? 'https://api.ebay.com';
  private readonly tokenKey = 'tcg:ebay:token';

  constructor(private readonly redis: Redis) {}

  private async getToken(force = false): Promise<string> {
    if (!force) {
      const cached = await this.redis.get(this.tokenKey);
      if (cached) return cached;
    }
    const id = process.env.EBAY_CLIENT_ID ?? '';
    const secret = process.env.EBAY_CLIENT_SECRET ?? '';
    if (!id || !secret) throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not configured');
    const basic = Buffer.from(`${id}:${secret}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    });
    if (!res.ok) throw new Error(`ebay token refresh failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    await this.redis.set(this.tokenKey, json.access_token, 'EX', Math.max(60, json.expires_in - 60));
    return json.access_token;
  }

  async searchSold(query: string, limit = 50): Promise<EbayItemSummary[]> {
    const token = await this.getToken();
    const url =
      `${this.baseUrl}/buy/browse/v1/item_summary/search` +
      `?q=${encodeURIComponent(query)}` +
      `&limit=${limit}` +
      `&filter=${encodeURIComponent('buyingOptions:{AUCTION},soldItemsOnly:true')}`;
    const res = await fetch(url, {
      headers: {
        authorization: ['Bearer', token].join(' '),
        'x-ebay-c-marketplace-id': 'EBAY_US',
      },
    });
    if (!res.ok) {
      this.logger.warn(`ebay search failed: ${res.status}`);
      return [];
    }
    const json = (await res.json()) as { itemSummaries?: EbayItemSummary[] };
    return json.itemSummaries ?? [];
  }

  /**
   * Compute a robust median price (in cents) over a list of summaries,
   * trimming the top and bottom 10% to reduce outlier influence.
   */
  static medianCents(items: EbayItemSummary[]): number | null {
    const cents = items
      .map((i) => Number(i.price?.value))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.round(n * 100))
      .sort((a, b) => a - b);
    if (cents.length === 0) return null;
    const trim = Math.floor(cents.length * 0.1);
    const trimmed = cents.slice(trim, cents.length - trim);
    if (trimmed.length === 0) return null;
    const mid = Math.floor(trimmed.length / 2);
    return trimmed.length % 2 === 0
      ? Math.round(((trimmed[mid - 1] ?? 0) + (trimmed[mid] ?? 0)) / 2)
      : trimmed[mid] ?? null;
  }
}
