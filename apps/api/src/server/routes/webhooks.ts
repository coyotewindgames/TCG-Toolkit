import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { schema, getDb } from '../../db/client';
import { asyncHandler } from '../../common/async-handler';
import { getLogger } from '../../common/logger';
import { loadEnv } from '../../config/env';
import { emitToOrder, SOCKET_EVENTS } from '../realtime/socket';
import { getQueues } from '../../jobs/queues';
import type { Container } from '../container';

/**
 * Inbound POS webhooks.
 *
 * `app.ts` mounts a raw-body capturing middleware on `/webhooks/*` BEFORE the
 * JSON parser so signature verification has the exact signed bytes.
 *
 * Each handler:
 *   1) verifies the provider signature
 *   2) writes an idempotency row (`webhook_events`, unique on (provider, event_id))
 *   3) processes the event; duplicates short-circuit
 *   4) on processing failure, enqueues `webhook.retry` for out-of-band retry
 *   5) always returns 200 so the provider stops retrying
 */
export function webhooksRouter(c: Container): Router {
  const r = Router();
  const db = getDb();
  const log = getLogger();
  const env = loadEnv();

  r.post(
    '/clover',
    asyncHandler(async (req, res) => {
      const raw =
        (req as typeof req & { rawBody?: Buffer }).rawBody?.toString('utf8') ??
        JSON.stringify(req.body ?? {});
      // Accept the configured header first, then a couple of common fallbacks.
      const signature =
        req.header(env.CLOVER_WEBHOOK_SIGNATURE_HEADER) ??
        req.header('x-clover-signature') ??
        req.header('x-clover-auth');
      const ok = c.pos.verifyWebhook({ rawBody: raw, signatureHeader: signature });
      const parsed = c.pos.parseWebhook(req.body);

      const inserted = await recordEvent(db, {
        provider: c.pos.name,
        providerEventId: parsed.providerEventId,
        eventType: parsed.eventType,
        signatureOk: ok,
        payload: (req.body ?? {}) as Record<string, unknown>,
      });
      if (!inserted) return res.json({ ok: true });
      if (!ok) {
        log.warn({ providerEventId: parsed.providerEventId }, 'webhook signature failed');
        return res.json({ ok: true });
      }

      try {
        if (parsed.paymentCompleted && parsed.referenceId) {
          await completeOrder(c, parsed.referenceId, parsed.posCheckoutId ?? '');
        }
      } catch (err) {
        log.error(
          { err, providerEventId: parsed.providerEventId },
          'webhook processing failed; queued for retry',
        );
        try {
          await getQueues().webhookRetry.add(
            'retry',
            { eventId: parsed.providerEventId, provider: c.pos.name },
            { attempts: 5, backoff: { type: 'exponential', delay: 5_000 } },
          );
        } catch (qerr) {
          log.error({ err: qerr }, 'failed to enqueue webhook retry');
        }
      }
      res.json({ ok: true });
    }),
  );

  return r;
}

async function recordEvent(
  db: ReturnType<typeof getDb>,
  args: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureOk: boolean;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    await db.insert(schema.webhookEvents).values({
      provider: args.provider,
      providerEventId: args.providerEventId,
      eventType: args.eventType,
      signatureOk: args.signatureOk,
      payload: args.payload,
    });
    return true;
  } catch (err) {
    // Only treat unique violations on (provider, provider_event_id) as
    // duplicates; surface every other failure so we don't silently 200 to the
    // provider while losing the event.
    const code = (err as { code?: string } | null)?.code;
    if (code === '23505') return false;
    throw err;
  }
}

async function completeOrder(c: Container, orderId: string, posCheckoutId: string): Promise<void> {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const [order] = await tx.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    if (!order) return null;
    if (order.status === 'paid') return null;

    const updated = await tx
      .update(schema.orders)
      .set({ status: 'paid', posCheckoutId, closedAt: new Date() })
      .where(and(eq(schema.orders.id, order.id), eq(schema.orders.status, 'pending_payment')))
      .returning({ id: schema.orders.id });
    if (updated.length === 0) return null;

    const items = await tx
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id));
    return { order, items };
  });
  if (!result) return;

  for (const line of result.items) {
    await c.inventory.commitSale({
      storeId: result.order.storeId,
      skuId: line.skuId,
      locationId: result.order.locationId,
      qty: line.quantity,
    });
  }

  emitToOrder(result.order.id, SOCKET_EVENTS.orderCompleted, {
    orderId: result.order.id,
    totalCents: result.order.totalCents,
    paymentProvider: c.pos.name,
    receiptUrl: result.order.receiptUrl ?? null,
  });
}
