import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { BadRequest, Conflict, NotFound } from '../../common/http-errors';
import { emitToOrder, SOCKET_EVENTS } from '../realtime/socket';
import { InventoryService } from './inventory';
import { ScansService } from './scans';

export class OrdersService {
  constructor(
    private readonly db: Database,
    private readonly inventory: InventoryService,
    private readonly scans: ScansService,
  ) {}

  async create(args: {
    storeId: string;
    locationId: string;
    registerId?: string;
    customerId?: string;
    userId: string;
  }) {
    const [row] = await this.db
      .insert(schema.orders)
      .values({
        storeId: args.storeId,
        locationId: args.locationId,
        registerId: args.registerId,
        customerId: args.customerId,
        status: 'open',
        createdBy: args.userId,
      })
      .returning();
    if (!row) throw new Error('failed to create order');
    return row;
  }

  async addScannedItem(args: { storeId: string; orderId: string; barcode: string }) {
    const order = await this.requireOpenOrder(args.storeId, args.orderId);
    const scan = await this.scans.resolveBarcode({
      storeId: args.storeId,
      barcode: args.barcode,
    });

    const reservableLocationId = await this.inventory.findReservableLocation({
      storeId: args.storeId,
      skuId: scan.skuId,
      preferredLocationId: order.locationId,
      qty: 1,
    });
    if (!reservableLocationId) {
      throw Conflict('item is out of stock at every location');
    }

    let reserveLocationId = order.locationId;
    if (reservableLocationId !== order.locationId) {
      const [lineCountRow] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.orderItems)
        .where(eq(schema.orderItems.orderId, order.id));
      const lineCount = Number(lineCountRow?.count ?? 0);
      if (lineCount > 0) {
        throw Conflict('item is stocked at a different location than the current cart');
      }

      await this.db
        .update(schema.orders)
        .set({ locationId: reservableLocationId })
        .where(eq(schema.orders.id, order.id));
      reserveLocationId = reservableLocationId;
      order.locationId = reservableLocationId;
    }

    await this.inventory.reserve({
      storeId: args.storeId,
      skuId: scan.skuId,
      locationId: reserveLocationId,
      qty: 1,
    });

    const [line] = await this.db
      .insert(schema.orderItems)
      .values({
        orderId: order.id,
        skuId: scan.skuId,
        quantity: 1,
        unitPriceCents: scan.priceCents,
        productNameSnapshot: scan.name,
      })
      .returning();
    if (!line) throw new Error('failed to add line');

    await this.recomputeTotals(order.id);
    const totals = await this.totals(order.id);

    const linePayload = {
      id: line.id,
      skuId: line.skuId,
      name: scan.name,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      imageUrl: scan.imageUrl,
    };

    emitToOrder(order.id, SOCKET_EVENTS.cartItemAdded, {
      orderId: order.id,
      line: linePayload,
      totals,
    });
    return { line: linePayload, totals };
  }

  async removeLine(args: { storeId: string; orderId: string; lineId: string }) {
    const order = await this.requireOpenOrder(args.storeId, args.orderId);
    const [line] = await this.db
      .select()
      .from(schema.orderItems)
      .where(
        and(eq(schema.orderItems.id, args.lineId), eq(schema.orderItems.orderId, order.id)),
      );
    if (!line) throw NotFound('line not found');

    await this.db.delete(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    await this.inventory.releaseReservation({
      storeId: args.storeId,
      skuId: line.skuId,
      locationId: order.locationId,
      qty: line.quantity,
    });
    await this.recomputeTotals(order.id);
    const totals = await this.totals(order.id);
    emitToOrder(order.id, SOCKET_EVENTS.cartItemRemoved, {
      orderId: order.id,
      lineId: line.id,
      totals,
    });
    return { totals };
  }

  async requireOpenOrder(storeId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.storeId, storeId)));
    if (!order) throw NotFound('order not found');
    if (order.status !== 'open' && order.status !== 'pending_payment') {
      throw BadRequest(`order is ${order.status}`);
    }
    return order;
  }

  async findById(storeId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.storeId, storeId)));
    if (!order) throw NotFound('order not found');
    const items = await this.db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id));
    return { order, items };
  }

  private async recomputeTotals(orderId: string): Promise<void> {
    const items = await this.db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, orderId));
    const subtotal = items.reduce(
      (s, l) => s + l.unitPriceCents * l.quantity - l.discountCents,
      0,
    );
    // Tax calculation is not implemented in MVP; persist 0 explicitly so the
    // total always reflects subtotal + tax instead of relying on a stale value.
    const taxCents = 0;
    await this.db
      .update(schema.orders)
      .set({ subtotalCents: subtotal, taxCents, totalCents: subtotal + taxCents })
      .where(eq(schema.orders.id, orderId));
  }

  async totals(orderId: string) {
    const [row] = await this.db
      .select({
        subtotalCents: schema.orders.subtotalCents,
        taxCents: schema.orders.taxCents,
        totalCents: schema.orders.totalCents,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    return row ?? { subtotalCents: 0, taxCents: 0, totalCents: 0 };
  }
}
