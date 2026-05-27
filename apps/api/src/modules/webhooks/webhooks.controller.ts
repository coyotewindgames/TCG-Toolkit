import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../db/database.module';
import { schema } from '../../db/client';
import type { Database } from '../../db/client';
import { SquareClient } from '../../integrations/square/square.client';
import { CloverClient } from '../../integrations/clover/clover.client';
import { InventoryService } from '../inventory/inventory.service';
import { RealtimeGateway, SOCKET_EVENTS } from '../realtime/realtime.gateway';

/**
 * Inbound webhooks. Every handler:
 *   1) verifies the provider signature
 *   2) writes a row into `webhook_events` (UNIQUE on (provider, event_id))
 *   3) processes idempotently — duplicates short-circuit on the unique violation
 *
 * `main.ts` must register a raw-body parser so signature verification has
 * the exact bytes the provider signed.
 */
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inventory: InventoryService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Post('square')
  @HttpCode(200)
  async square(
    @Req() req: Request,
    @Headers('x-square-hmacsha256-signature') signature: string | undefined,
    @Body() body: SquareWebhookBody,
  ) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';
    const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ?? '';
    const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? '';
    const ok = SquareClient.verifyWebhookSignature({
      notificationUrl,
      rawBody,
      signatureHeader: signature,
      signatureKey,
    });

    const inserted = await this.recordEvent({
      provider: 'square',
      providerEventId: body.event_id,
      eventType: body.type,
      signatureOk: ok,
      payload: body as unknown as Record<string, unknown>,
    });
    if (!inserted) {
      this.logger.warn(`duplicate square event ${body.event_id}, skipping`);
      return { ok: true };
    }
    if (!ok) {
      this.logger.error(`square webhook signature verification failed: ${body.event_id}`);
      return { ok: true }; // 200 to avoid retries on hard-broken config; alert via logs.
    }

    if (body.type === 'terminal.checkout.updated') {
      const checkout = body.data?.object?.checkout;
      if (checkout?.status === 'COMPLETED' && checkout.reference_id) {
        await this.completeOrder(checkout.reference_id, 'square', checkout.id);
      }
    }
    return { ok: true };
  }

  @Post('clover')
  @HttpCode(200)
  async clover(
    @Req() req: Request,
    @Headers('x-clover-auth') signature: string | undefined,
    @Body() body: CloverWebhookBody,
  ) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';
    const ok = CloverClient.verifyWebhookSignature({
      rawBody,
      signatureHeader: signature,
      signingSecret: process.env.CLOVER_WEBHOOK_SIGNING_SECRET ?? '',
    });

    // Clover uses `merchants[].id + objectId + type + ts` as a synthetic id.
    const eventId =
      body.eventId ?? `${body.merchants?.[0]?.id ?? 'unknown'}:${body.objectId ?? ''}:${body.ts ?? ''}`;
    const inserted = await this.recordEvent({
      provider: 'clover',
      providerEventId: eventId,
      eventType: body.type ?? 'unknown',
      signatureOk: ok,
      payload: body as unknown as Record<string, unknown>,
    });
    if (!inserted) return { ok: true };
    if (!ok) {
      this.logger.error(`clover webhook signature verification failed: ${eventId}`);
      return { ok: true };
    }

    if (body.type === 'PAYMENTS_CREATED' && body.objectId) {
      // Clover payment notifications need a follow-up GET to resolve order id.
      // Implementation left as TODO once merchant test credentials are wired.
      this.logger.log(`clover payment notification: ${body.objectId}`);
    }
    return { ok: true };
  }

  // ---- helpers ----

  private async recordEvent(args: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureOk: boolean;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    try {
      await this.db.insert(schema.webhookEvents).values({
        provider: args.provider,
        providerEventId: args.providerEventId,
        eventType: args.eventType,
        signatureOk: args.signatureOk,
        payload: args.payload,
      });
      return true;
    } catch {
      return false; // unique violation = duplicate
    }
  }

  private async completeOrder(orderId: string, provider: 'square' | 'clover', posCheckoutId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    if (!order) {
      this.logger.warn(`unknown order in webhook: ${orderId}`);
      return;
    }
    if (order.status === 'paid') return; // already settled

    const items = await this.db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id));

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.orders)
        .set({
          status: 'paid',
          posCheckoutId,
          closedAt: new Date(),
        })
        .where(and(eq(schema.orders.id, order.id), eq(schema.orders.status, 'pending_payment')));
    });

    for (const line of items) {
      await this.inventory.commitSale({
        storeId: order.storeId,
        skuId: line.skuId,
        locationId: order.locationId,
        qty: line.quantity,
      });
    }

    this.realtime.emitToOrder(order.id, SOCKET_EVENTS.orderCompleted, {
      orderId: order.id,
      totalCents: order.totalCents,
      paymentProvider: provider,
      receiptUrl: order.receiptUrl ?? null,
    });
  }
}

// Webhook body shapes (we only type the fields we read).
interface SquareWebhookBody {
  event_id: string;
  type: string;
  data?: {
    object?: {
      checkout?: { id: string; status: string; reference_id?: string };
    };
  };
}

interface CloverWebhookBody {
  eventId?: string;
  type?: string;
  objectId?: string;
  ts?: number;
  merchants?: Array<{ id: string }>;
}
