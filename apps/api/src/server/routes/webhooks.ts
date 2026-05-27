import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { schema, getDb } from '../../db/client';
import { asyncHandler } from '../../common/async-handler';
import { emitToOrder, SOCKET_EVENTS } from '../realtime/socket';
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
 *   4) always returns 200 so the provider stops retrying
 */
export function webhooksRouter(c: Container): Router {
  const r = Router();
  const db = getDb();

  r.post(
    '/clover',
    asyncHandler(async (req, res) => {
      const raw =
        (req as typeof req & { rawBody?: Buffer }).rawBody?.toString('utf8') ??
        JSON.stringify(req.body ?? {});
      const signature = req.header('x-clover-auth');
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
        // eslint-disable-next-line no-console
        console.error(`webhook signature failed: ${parsed.providerEventId}`);
        return res.json({ ok: true });
      }

      if (parsed.paymentCompleted && parsed.referenceId) {
        await completeOrder(c, parsed.referenceId, parsed.posCheckoutId ?? '');
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
  } catch {
    return false; // unique violation = duplicate
  }
}

async function completeOrder(c: Container, orderId: string, posCheckoutId: string): Promise<void> {
  const db = getDb();
  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  if (!order) return;
  if (order.status === 'paid') return;

  const items = await db
    .select()
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, order.id));

  await db
    .update(schema.orders)
    .set({ status: 'paid', posCheckoutId, closedAt: new Date() })
    .where(and(eq(schema.orders.id, order.id), eq(schema.orders.status, 'pending_payment')));

  for (const line of items) {
    await c.inventory.commitSale({
      storeId: order.storeId,
      skuId: line.skuId,
      locationId: order.locationId,
      qty: line.quantity,
    });
  }

  emitToOrder(order.id, SOCKET_EVENTS.orderCompleted, {
    orderId: order.id,
    totalCents: order.totalCents,
    paymentProvider: c.pos.name,
    receiptUrl: order.receiptUrl ?? null,
  });
}
