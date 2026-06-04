import { and, eq, inArray } from 'drizzle-orm';
import type { CheckoutRequest } from '@tcg/shared';
import { schema, type Database } from '../../db/client';
import { BadRequest } from '../../common/http-errors';
import type { CloverClient } from '../../integrations/pos/clover';
import { OrdersService } from './orders';

export type PosFactory = (storeId: string) => Promise<CloverClient>;

export class CheckoutService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrdersService,
    private readonly posFor: PosFactory,
  ) {}

  /**
   * Start a POS terminal checkout for an existing local order. The Clover
   * client is built per-call so each store's encrypted credentials are
   * resolved fresh (with ConfigService's cache absorbing the hot path).
   */
  async start(storeId: string, orderId: string, req: CheckoutRequest) {
    const { order, items } = await this.orders.findById(storeId, orderId);
    if (items.length === 0) throw BadRequest('order has no items');

    const pos = await this.posFor(storeId);

    const skuIds = items.map((line) => line.skuId);
    const skuRows = await this.db
      .select({ id: schema.skus.id, name: schema.products.name })
      .from(schema.skus)
      .innerJoin(schema.products, eq(schema.products.id, schema.skus.productId))
      .where(inArray(schema.skus.id, skuIds));
    const namesBySkuId = new Map(skuRows.map((r) => [r.id, r.name]));

    const lineItems = items.map((line) => ({
      name: namesBySkuId.get(line.skuId) ?? 'TCG Item',
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
    }));

    const created = await pos.createOrder({
      referenceId: order.id,
      lineItems,
      tipCents: req.tipCents,
    });

    const checkout = await pos.startTerminalCheckout({
      referenceId: order.id,
      posOrderId: created.posOrderId,
      deviceId: req.deviceId,
      amountCents: (order.totalCents ?? 0) + (req.tipCents ?? 0),
      tipCents: req.tipCents,
    });

    await this.db
      .update(schema.orders)
      .set({
        status: 'pending_payment',
        posProvider: pos.name,
        posOrderId: created.posOrderId,
        posCheckoutId: checkout.posCheckoutId,
        tipCents: req.tipCents ?? 0,
      })
      .where(and(eq(schema.orders.id, order.id), eq(schema.orders.storeId, storeId)));

    return {
      provider: pos.name,
      posOrderId: created.posOrderId,
      posCheckoutId: checkout.posCheckoutId,
      status: checkout.status,
    };
  }
}
