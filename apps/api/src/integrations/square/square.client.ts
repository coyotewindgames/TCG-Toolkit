import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

interface SquareLineItem {
  name: string;
  quantity: string;
  base_price_money: { amount: number; currency: string };
  note?: string;
}

interface SquareCreateOrderResponse {
  order: { id: string; total_money: { amount: number } };
}

interface SquareCreateTerminalCheckoutResponse {
  checkout: { id: string; status: string };
}

/**
 * Minimal Square client covering the surface used by our checkout flow:
 *   - CreateOrder (ad-hoc line items, because TCGplayer SKU granularity
 *     exceeds Square's catalog model)
 *   - CreateTerminalCheckout (push the payment to a paired device)
 *   - Webhook signature verification
 */
@Injectable()
export class SquareClient {
  private readonly logger = new Logger(SquareClient.name);
  private readonly baseUrl =
    (process.env.SQUARE_ENV ?? 'sandbox') === 'production'
      ? 'https://connect.squareup.com'
      : 'https://connect.squareupsandbox.com';

  private get token() {
    const t = process.env.SQUARE_ACCESS_TOKEN ?? '';
    if (!t) throw new Error('SQUARE_ACCESS_TOKEN not configured');
    return t;
  }

  private get locationId() {
    const l = process.env.SQUARE_LOCATION_ID ?? '';
    if (!l) throw new Error('SQUARE_LOCATION_ID not configured');
    return l;
  }

  async createOrder(opts: {
    idempotencyKey: string;
    lineItems: SquareLineItem[];
  }): Promise<SquareCreateOrderResponse> {
    const res = await fetch(`${this.baseUrl}/v2/orders`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        idempotency_key: opts.idempotencyKey,
        order: {
          location_id: this.locationId,
          line_items: opts.lineItems,
        },
      }),
    });
    if (!res.ok) throw new Error(`square createOrder ${res.status}: ${await res.text()}`);
    return (await res.json()) as SquareCreateOrderResponse;
  }

  async createTerminalCheckout(opts: {
    idempotencyKey: string;
    deviceId: string;
    amountCents: number;
    referenceId: string;
    note?: string;
  }): Promise<SquareCreateTerminalCheckoutResponse> {
    const res = await fetch(`${this.baseUrl}/v2/terminals/checkouts`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        idempotency_key: opts.idempotencyKey,
        checkout: {
          amount_money: { amount: opts.amountCents, currency: 'USD' },
          device_options: { device_id: opts.deviceId },
          reference_id: opts.referenceId,
          note: opts.note,
        },
      }),
    });
    if (!res.ok)
      throw new Error(`square createTerminalCheckout ${res.status}: ${await res.text()}`);
    return (await res.json()) as SquareCreateTerminalCheckoutResponse;
  }

  /**
   * Verify a Square webhook signature.
   *
   * Square signs `notificationUrl + rawBody` with HMAC-SHA256 using the
   * subscription's "signature key" and sends the base64 result in the
   * `x-square-hmacsha256-signature` header.
   */
  static verifyWebhookSignature(args: {
    notificationUrl: string;
    rawBody: string;
    signatureHeader: string | undefined;
    signatureKey: string;
  }): boolean {
    if (!args.signatureHeader) return false;
    const hmac = createHmac('sha256', args.signatureKey);
    hmac.update(args.notificationUrl + args.rawBody);
    const expected = hmac.digest('base64');
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
      'square-version': '2024-09-19',
    };
  }
}
