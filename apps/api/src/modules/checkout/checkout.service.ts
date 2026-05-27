import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE } from '../../db/database.module';
import { schema } from '../../db/client';
import type { Database } from '../../db/client';
import type { CheckoutRequest } from '@tcg/shared';
import { OrdersService } from '../orders/orders.service';
import { SquareClient } from '../../integrations/square/square.client';
import { CloverClient } from '../../integrations/clover/clover.client';

@Injectable()
export class CheckoutService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly orders: OrdersService,
    private readonly square: SquareClient,
    private readonly clover: CloverClient,
  ) {}

  /**
   * Start a POS terminal checkout for an existing local order.
   * The flow is:
   *   1) snapshot line items into the POS as ad-hoc items
   *   2) create a terminal checkout pointing at the paired device
   *   3) store the POS ids on the order; mark as `pending_payment`
   *   4) wait for the POS webhook to actually settle inventory
   */
  async start(storeId: string, orderId: string, req: CheckoutRequest) {
    const { order, items } = await this.orders.findById(storeId, orderId);
    if (items.length === 0) throw new BadRequestException('order has no items');

    // Hydrate names for the POS receipt.
    const lineItems = await Promise.all(
      items.map(async (line) => {
        const [sku] = await this.db
          .select({ name: schema.products.name })
          .from(schema.skus)
          .innerJoin(schema.products, eq(schema.products.id, schema.skus.productId))
          .where(eq(schema.skus.id, line.skuId));
        return {
          name: sku?.name ?? 'TCG Item',
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
        };
      }),
    );

    const idempotencyKey = `${order.id}:${randomUUID()}`;

    if (req.provider === 'square') {
      const created = await this.square.createOrder({
        idempotencyKey,
        lineItems: lineItems.map((l) => ({
          name: l.name,
          quantity: String(l.quantity),
          base_price_money: { amount: l.unitPriceCents, currency: 'USD' },
        })),
      });
      const checkout = await this.square.createTerminalCheckout({
        idempotencyKey: `${idempotencyKey}:term`,
        deviceId: req.deviceId,
        amountCents: (order.totalCents ?? 0) + (req.tipCents ?? 0),
        referenceId: order.id,
      });
      await this.db
        .update(schema.orders)
        .set({
          status: 'pending_payment',
          posProvider: 'square',
          posOrderId: created.order.id,
          posCheckoutId: checkout.checkout.id,
          tipCents: req.tipCents ?? 0,
        })
        .where(and(eq(schema.orders.id, order.id), eq(schema.orders.storeId, storeId)));
      return { provider: 'square' as const, checkoutId: checkout.checkout.id };
    }

    // Clover path.
    const created = await this.clover.createOrder({
      referenceId: order.id,
      lineItems: lineItems.map((l) => ({
        name: l.name,
        price: l.unitPriceCents,
        quantity: l.quantity,
      })),
    });
    await this.db
      .update(schema.orders)
      .set({
        status: 'pending_payment',
        posProvider: 'clover',
        posOrderId: created.id,
        tipCents: req.tipCents ?? 0,
      })
      .where(and(eq(schema.orders.id, order.id), eq(schema.orders.storeId, storeId)));
    return { provider: 'clover' as const, posOrderId: created.id };
  }
}
