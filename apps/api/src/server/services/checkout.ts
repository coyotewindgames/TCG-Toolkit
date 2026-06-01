import { and, eq, inArray } from 'drizzle-orm';
import type { CheckoutRequest } from '@tcg/shared';
import { schema, type Database } from '../../db/client';
import { BadRequest } from '../../common/http-errors';
import type { CloverClient } from '../../integrations/pos/clover';
import { OrdersService } from './orders';

export class CheckoutService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrdersService,
    private readonly pos: CloverClient,
  ) {}

  /**
   * Start a POS terminal checkout for an existing local order.
   *
   *   1) snapshot line items into the POS as ad-hoc items
   *   2) start a terminal checkout pointing at the paired device
   *   3) store POS ids on the order; mark as `pending_payment`
   *   4) wait for the POS webhook to settle inventory (commit signal)
   */
  async start(storeId: string, orderId: string, req: CheckoutRequest) {
    const { order, items } = await this.orders.findById(storeId, orderId);
    if (items.length === 0) throw BadRequest('order has no items');

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

    const created = await this.pos.createOrder({
      referenceId: order.id,
      lineItems,
      tipCents: req.tipCents,
    });

    const checkout = await this.pos.startTerminalCheckout({
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
        posProvider: this.pos.name,
        posOrderId: created.posOrderId,
        posCheckoutId: checkout.posCheckoutId,
        tipCents: req.tipCents ?? 0,
      })
      .where(and(eq(schema.orders.id, order.id), eq(schema.orders.storeId, storeId)));

    return {
      provider: this.pos.name,
      posOrderId: created.posOrderId,
      posCheckoutId: checkout.posCheckoutId,
      status: checkout.status,
    };
  }
}
