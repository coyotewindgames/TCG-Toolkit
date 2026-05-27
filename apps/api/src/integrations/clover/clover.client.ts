import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal Clover Ecommerce client. The Clover REST surface differs
 * substantially from Square; we only implement what our checkout flow needs.
 */
@Injectable()
export class CloverClient {
  private readonly logger = new Logger(CloverClient.name);
  private readonly baseUrl = process.env.CLOVER_BASE_URL ?? 'https://sandbox.dev.clover.com';

  private get token() {
    const t = process.env.CLOVER_ACCESS_TOKEN ?? '';
    if (!t) throw new Error('CLOVER_ACCESS_TOKEN not configured');
    return t;
  }

  private get merchantId() {
    const m = process.env.CLOVER_MERCHANT_ID ?? '';
    if (!m) throw new Error('CLOVER_MERCHANT_ID not configured');
    return m;
  }

  async createOrder(opts: {
    referenceId: string;
    lineItems: Array<{ name: string; price: number; quantity: number }>;
  }): Promise<{ id: string }> {
    const res = await fetch(`${this.baseUrl}/v3/merchants/${this.merchantId}/orders`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ externalReferenceId: opts.referenceId, state: 'open' }),
    });
    if (!res.ok) throw new Error(`clover createOrder ${res.status}: ${await res.text()}`);
    const order = (await res.json()) as { id: string };
    for (const line of opts.lineItems) {
      const r = await fetch(
        `${this.baseUrl}/v3/merchants/${this.merchantId}/orders/${order.id}/line_items`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            name: line.name,
            price: line.price,
            unitQty: line.quantity * 1000, // Clover uses millinunits
          }),
        },
      );
      if (!r.ok) throw new Error(`clover addLineItem ${r.status}`);
    }
    return order;
  }

  /**
   * Clover signs webhooks with an HMAC-SHA256 of the raw body using the
   * developer-portal signing secret, returned in `x-clover-auth` (varies by
   * setup). Verify before trusting any payload.
   */
  static verifyWebhookSignature(args: {
    rawBody: string;
    signatureHeader: string | undefined;
    signingSecret: string;
  }): boolean {
    if (!args.signatureHeader) return false;
    const hmac = createHmac('sha256', args.signingSecret);
    hmac.update(args.rawBody);
    const expected = hmac.digest('hex');
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(args.signatureHeader);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: ['Bearer', this.token].join(' '),
      'content-type': 'application/json',
    };
  }
}
