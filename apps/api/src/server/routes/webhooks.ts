import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { schema, getDb } from '../../db/client';
import { asyncHandler } from '../../common/async-handler';
import { getLogger } from '../../common/logger';
import { loadEnv } from '../../config/env';
import { CloverClient } from '../../integrations/pos/clover';
import { emitToOrder, SOCKET_EVENTS } from '../realtime/socket';
import { getQueues } from '../../jobs/queues';
import type { Container } from '../container';

/**
 * Inbound POS webhooks.
 *
 * `app.ts` mounts a raw-body capturing middleware on `/webhooks/*` BEFORE the
 * JSON parser so signature verification has the exact signed bytes.
 *
 * Because POS credentials now live per-store, the handler must locate the
 * owning store BEFORE it can verify the signature. Clover always includes
 * `merchants[0].id` in the payload; that's plaintext and indexed on
 * `pos_configs.merchant_id`, so the lookup is one DB hit.
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
      const signature =
        req.header(env.CLOVER_WEBHOOK_SIGNATURE_HEADER) ??
        req.header('x-clover-signature') ??
        req.header('x-clover-auth');

      const body = (req.body ?? {}) as {
        merchants?: Array<{ id?: string }>;
      };
      const merchantId = body.merchants?.[0]?.id;

      if (!merchantId) {
        log.warn('clover webhook missing merchants[0].id; dropping');
        return res.json({ ok: true });
      }

      let creds: Awaited<ReturnType<typeof c.configs.getPosByMerchantId>>;
      try {
        creds = await c.configs.getPosByMerchantId(merchantId);
      } catch {
        // Unknown merchant — not for any store we manage. 200 so Clover stops
        // retrying; log so an operator can investigate misconfigured webhooks.
        log.warn({ merchantId }, 'clover webhook for unknown merchant');
        return res.json({ ok: true });
      }

      const pos = new CloverClient({
        baseUrl: creds.baseUrl,
        accessToken: creds.accessToken,
        merchantId: creds.merchantId,
        webhookSigningSecret: creds.webhookSigningSecret,
      });

      const ok = pos.verifyWebhook({ rawBody: raw, signatureHeader: signature });
      const parsed = pos.parseWebhook(req.body);

      const inserted = await recordEvent(db, {
        provider: pos.name,
        providerEventId: parsed.providerEventId,
        eventType: parsed.eventType,
        signatureOk: ok,
        payload: (req.body ?? {}) as Record<string, unknown>,
      });
      if (!inserted) return res.json({ ok: true });
      if (!ok) {
        log.warn({ providerEventId: parsed.providerEventId, merchantId }, 'webhook signature failed');
        return res.json({ ok: true });
      }

      try {
        if (parsed.paymentCompleted && parsed.referenceId) {
          await completeOrder(
            c,
            creds.storeId,
            pos.name,
            parsed.referenceId,
            parsed.posCheckoutId ?? '',
          );
        }
      } catch (err) {
        log.error(
          { err, providerEventId: parsed.providerEventId },
          'webhook processing failed; queued for retry',
        );
        try {
          await getQueues().webhookRetry.add(
            'retry',
            { eventId: parsed.providerEventId, provider: pos.name },
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
    const code = (err as { code?: string } | null)?.code;
    if (code === '23505') return false;
    throw err;
  }
}

async function completeOrder(
  c: Container,
  storeId: string,
  providerName: string,
  orderId: string,
  posCheckoutId: string,
): Promise<void> {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.storeId, storeId)));
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
    paymentProvider: providerName,
    receiptUrl: result.order.receiptUrl ?? null,
  });
}
