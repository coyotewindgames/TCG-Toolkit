/**
 * Abstract POS provider interface. The checkout flow and webhook handlers
 * depend on this surface; concrete providers (Clover for MVP) implement it.
 *
 * Keeping this thin lets us plug Square or another vendor in without
 * touching service code.
 */
export interface PosLineItem {
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface PosCreateOrderInput {
  referenceId: string; // our internal order id
  lineItems: PosLineItem[];
  tipCents?: number;
}

export interface PosCreateOrderResult {
  posOrderId: string;
}

export interface PosStartCheckoutInput {
  referenceId: string;
  posOrderId: string;
  deviceId: string;
  amountCents: number;
  tipCents?: number;
}

export interface PosStartCheckoutResult {
  posCheckoutId: string;
  status: string;
}

export interface PosWebhookVerifyInput {
  rawBody: string;
  signatureHeader: string | undefined;
  notificationUrl?: string; // optional; some providers (Square) sign URL + body
}

export interface PosParsedWebhook {
  /** Vendor-supplied event id; falls back to a synthetic id when absent. */
  providerEventId: string;
  eventType: string;
  /** Our internal order id, if present in the payload. */
  referenceId?: string | null;
  /** Provider-side checkout/payment id. */
  posCheckoutId?: string | null;
  /** True when the payment has completed. Triggers inventory commit. */
  paymentCompleted: boolean;
}

export interface PosProvider {
  readonly name: 'clover';
  createOrder(input: PosCreateOrderInput): Promise<PosCreateOrderResult>;
  startTerminalCheckout(input: PosStartCheckoutInput): Promise<PosStartCheckoutResult>;
  verifyWebhook(input: PosWebhookVerifyInput): boolean;
  parseWebhook(payload: unknown): PosParsedWebhook;
}
