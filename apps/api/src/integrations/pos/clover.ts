/**
 * Minimal Clover Ecommerce client. The Clover REST surface differs
 * substantially from other POS vendors; we only implement what our checkout
 * flow needs.
 *
 * NOTE: Clover terminal pairing & "secure payment requests" require the
 * merchant-side Clover device to be paired with the API integration first.
 * The `startTerminalCheckout` method here represents that handoff; production
 * deployments may need to swap the underlying endpoint for the merchant's
 * specific Clover device class.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../../config/env';
import type {
  PosCreateOrderInput,
  PosCreateOrderResult,
  PosParsedWebhook,
  PosProvider,
  PosStartCheckoutInput,
  PosStartCheckoutResult,
  PosWebhookVerifyInput,
} from '../pos/provider';

interface CloverWebhookPayload {
  eventId?: string;
  type?: string;
  objectId?: string;
  ts?: number;
  merchants?: Array<{ id: string }>;
  externalReferenceId?: string;
  state?: string;
}

export class CloverClient implements PosProvider {
  readonly name = 'clover' as const;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly merchantId: string;
  private readonly webhookSigningSecret: string;

  constructor(env = loadEnv()) {
    this.baseUrl = env.CLOVER_BASE_URL.replace(/\/$/, '');
    this.token = env.CLOVER_ACCESS_TOKEN ?? '';
    this.merchantId = env.CLOVER_MERCHANT_ID ?? '';
    this.webhookSigningSecret = env.CLOVER_WEBHOOK_SIGNING_SECRET ?? '';
  }

  async createOrder(opts: PosCreateOrderInput): Promise<PosCreateOrderResult> {
    this.requireCredentials();
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
            price: line.unitPriceCents,
            unitQty: line.quantity * 1000, // Clover uses milliunits
          }),
        },
      );
      if (!r.ok) throw new Error(`clover addLineItem ${r.status}: ${await r.text()}`);
    }

    return { posOrderId: order.id };
  }

  async startTerminalCheckout(input: PosStartCheckoutInput): Promise<PosStartCheckoutResult> {
    this.requireCredentials();
    // Clover's terminal handoff varies by device class. As a portable
    // approximation we tag the order with the target device and rely on the
    // merchant's pre-paired Clover Mini/Flex to pick it up. Replace this with
    // the merchant-specific endpoint once known.
    const res = await fetch(
      `${this.baseUrl}/v3/merchants/${this.merchantId}/orders/${input.posOrderId}/payments`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          amount: input.amountCents,
          tipAmount: input.tipCents ?? 0,
          externalReferenceId: input.referenceId,
          device: { id: input.deviceId },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`clover startTerminalCheckout ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { id?: string; result?: string };
    return {
      posCheckoutId: json.id ?? input.posOrderId,
      status: json.result ?? 'PENDING',
    };
  }

  verifyWebhook(input: PosWebhookVerifyInput): boolean {
    if (!input.signatureHeader || !this.webhookSigningSecret) return false;
    return CloverClient.verifyWebhookSignature({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader,
      signingSecret: this.webhookSigningSecret,
    });
  }

  parseWebhook(payload: unknown): PosParsedWebhook {
    const body = (payload ?? {}) as CloverWebhookPayload;
    const eventId =
      body.eventId ??
      `${body.merchants?.[0]?.id ?? 'unknown'}:${body.objectId ?? ''}:${body.ts ?? ''}`;
    return {
      providerEventId: eventId,
      eventType: body.type ?? 'unknown',
      referenceId: body.externalReferenceId ?? null,
      posCheckoutId: body.objectId ?? null,
      paymentCompleted: body.type === 'PAYMENTS_CREATED' || body.state === 'PAID',
    };
  }

  /**
   * Clover signs webhooks with an HMAC-SHA256 of the raw body using the
   * developer-portal signing secret, returned in `x-clover-auth` (varies by
   * setup).
   */
  static verifyWebhookSignature(args: {
    rawBody: string;
    signatureHeader: string;
    signingSecret: string;
  }): boolean {
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

  private requireCredentials(): void {
    if (!this.token) throw new Error('CLOVER_ACCESS_TOKEN not configured');
    if (!this.merchantId) throw new Error('CLOVER_MERCHANT_ID not configured');
  }
}
