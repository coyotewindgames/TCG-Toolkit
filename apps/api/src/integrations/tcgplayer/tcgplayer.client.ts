import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Minimal TCGplayer API client.
 *
 * Authentication: OAuth2 client-credentials. The bearer token is cached in
 * Redis under `tcg:tcgplayer:token` so all API/worker instances share it.
 *
 * Rate limiting / retry: callers should wrap in a BullMQ job with backoff;
 * this client only retries the token refresh on 401.
 */
@Injectable()
export class TcgplayerClient {
  private readonly logger = new Logger(TcgplayerClient.name);
  private readonly baseUrl = process.env.TCGPLAYER_BASE_URL ?? 'https://api.tcgplayer.com';
  private readonly tokenKey = 'tcg:tcgplayer:token';

  constructor(private readonly redis: Redis) {}

  private async getToken(force = false): Promise<string> {
    if (!force) {
      const cached = await this.redis.get(this.tokenKey);
      if (cached) return cached;
    }
    const publicKey = process.env.TCGPLAYER_PUBLIC_KEY ?? '';
    const privateKey = process.env.TCGPLAYER_PRIVATE_KEY ?? '';
    if (!publicKey || !privateKey) {
      throw new Error('TCGPLAYER_PUBLIC_KEY / TCGPLAYER_PRIVATE_KEY not configured');
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: publicKey,
      client_secret: privateKey,
    });
    const res = await fetch(`${this.baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`tcgplayer token refresh failed: ${res.status}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    // Cache slightly under the actual TTL so we don't serve an expired token.
    const ttl = Math.max(60, json.expires_in - 60);
    await this.redis.set(this.tokenKey, json.access_token, 'EX', ttl);
    return json.access_token;
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: ['Bearer', token].join(' '),
        accept: 'application/json',
      },
    });
    if (res.status === 401 && retry) {
      this.logger.warn('tcgplayer 401, refreshing token');
      await this.getToken(true);
      return this.request(path, init, false);
    }
    if (!res.ok) {
      throw new Error(`tcgplayer ${path} -> ${res.status}`);
    }
    return (await res.json()) as T;
  }

  // Public methods (return raw JSON; mappers live in the sync workers).

  getCategories() {
    return this.request<{ results: unknown[] }>(`/catalog/categories?limit=100`);
  }

  getProducts(productIds: number[]) {
    return this.request<{ results: unknown[] }>(
      `/catalog/products/${productIds.join(',')}?getExtendedFields=true`,
    );
  }

  getPricing(productIds: number[]) {
    return this.request<{ results: unknown[] }>(`/pricing/product/${productIds.join(',')}`);
  }

  getStoreInventory(storeKey = process.env.TCGPLAYER_STORE_KEY ?? '') {
    if (!storeKey) throw new Error('TCGPLAYER_STORE_KEY not configured');
    return this.request<{ results: unknown[] }>(`/stores/${storeKey}/inventory/skus?limit=100`);
  }
}
