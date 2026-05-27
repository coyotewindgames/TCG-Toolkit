import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../db/database.module';
import { schema } from '../../db/client';
import type { Database } from '../../db/client';
import { InventoryService } from '../inventory/inventory.service';
import { ScansService } from '../scans/scans.service';
import { RealtimeGateway, SOCKET_EVENTS } from '../realtime/realtime.gateway';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inventory: InventoryService,
    private readonly scans: ScansService,
    private readonly realtime: RealtimeGateway,
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

    await this.inventory.reserve({
      storeId: args.storeId,
      skuId: scan.skuId,
      locationId: order.locationId,
      qty: 1,
    });

    const [line] = await this.db
      .insert(schema.orderItems)
      .values({
        orderId: order.id,
        skuId: scan.skuId,
        quantity: 1,
        unitPriceCents: scan.priceCents, // snapshot price at scan time
      })
      .returning();
    if (!line) throw new Error('failed to add line');

    await this.recomputeTotals(order.id);
    const totals = await this.totals(order.id);

    this.realtime.emitToOrder(order.id, SOCKET_EVENTS.cartItemAdded, {
      orderId: order.id,
      line: {
        id: line.id,
        skuId: line.skuId,
        name: scan.name,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        imageUrl: scan.imageUrl,
      },
      totals,
    });
    return { line, totals };
  }

  async removeLine(args: { storeId: string; orderId: string; lineId: string }) {
    const order = await this.requireOpenOrder(args.storeId, args.orderId);
    const [line] = await this.db
      .select()
      .from(schema.orderItems)
      .where(
        and(eq(schema.orderItems.id, args.lineId), eq(schema.orderItems.orderId, order.id)),
      );
    if (!line) throw new NotFoundException('line not found');

    await this.db.delete(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    await this.inventory.releaseReservation({
      storeId: args.storeId,
      skuId: line.skuId,
      locationId: order.locationId,
      qty: line.quantity,
    });
    await this.recomputeTotals(order.id);
    const totals = await this.totals(order.id);
    this.realtime.emitToOrder(order.id, SOCKET_EVENTS.cartItemRemoved, {
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
    if (!order) throw new NotFoundException('order not found');
    if (order.status !== 'open' && order.status !== 'pending_payment') {
      throw new BadRequestException(`order is ${order.status}`);
    }
    return order;
  }

  async findById(storeId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.storeId, storeId)));
    if (!order) throw new NotFoundException('order not found');
    const items = await this.db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id));
    return { order, items };
  }

  /** Recompute subtotal/total. Tax is left to the POS for accuracy. */
  private async recomputeTotals(orderId: string) {
    const items = await this.db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, orderId));
    const subtotal = items.reduce(
      (s, l) => s + l.unitPriceCents * l.quantity - l.discountCents,
      0,
    );
    await this.db
      .update(schema.orders)
      .set({ subtotalCents: subtotal, totalCents: subtotal })
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
