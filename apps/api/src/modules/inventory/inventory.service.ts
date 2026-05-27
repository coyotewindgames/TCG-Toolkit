import { Inject, Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../db/database.module';
import type { Database } from '../../db/client';
import { schema } from '../../db/client';
import { RealtimeGateway, SOCKET_EVENTS } from '../realtime/realtime.gateway';

/**
 * Inventory mutations.
 *
 * All quantity changes go through here so we can enforce row-level locking
 * (`SELECT ... FOR UPDATE`) and emit `inventory.updated` events.
 */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Atomically reserve `qty` of `skuId` at `locationId`.
   * Throws ConflictException if insufficient on-hand quantity.
   */
  async reserve(args: {
    storeId: string;
    skuId: string;
    locationId: string;
    qty: number;
  }): Promise<void> {
    if (args.qty <= 0) throw new ConflictException('qty must be positive');
    await this.db.transaction(async (tx) => {
      // Lock the inventory row.
      const rows = await tx.execute(sql`
        select qty_on_hand, qty_reserved
        from inventory
        where sku_id = ${args.skuId} and location_id = ${args.locationId}
        for update
      `);
      const row = (rows.rows as Array<{ qty_on_hand: number; qty_reserved: number }>)[0];
      if (!row) throw new NotFoundException('inventory row not found');
      const available = row.qty_on_hand - row.qty_reserved;
      if (available < args.qty) {
        throw new ConflictException(`only ${available} available`);
      }
      await tx
        .update(schema.inventory)
        .set({
          qtyReserved: sql`${schema.inventory.qtyReserved} + ${args.qty}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.inventory.skuId, args.skuId),
            eq(schema.inventory.locationId, args.locationId),
          ),
        );
    });
    this.emitUpdated(args.storeId, args.skuId);
  }

  /** Release a reservation without selling. */
  async releaseReservation(args: {
    storeId: string;
    skuId: string;
    locationId: string;
    qty: number;
  }): Promise<void> {
    await this.db
      .update(schema.inventory)
      .set({
        qtyReserved: sql`greatest(0, ${schema.inventory.qtyReserved} - ${args.qty})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.inventory.skuId, args.skuId),
          eq(schema.inventory.locationId, args.locationId),
        ),
      );
    this.emitUpdated(args.storeId, args.skuId);
  }

  /** Convert reserved → on_hand decrement. Called from a paid-webhook handler. */
  async commitSale(args: {
    storeId: string;
    skuId: string;
    locationId: string;
    qty: number;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        update inventory
        set qty_on_hand = greatest(0, qty_on_hand - ${args.qty}),
            qty_reserved = greatest(0, qty_reserved - ${args.qty}),
            updated_at = now()
        where sku_id = ${args.skuId} and location_id = ${args.locationId}
      `);
    });
    this.emitUpdated(args.storeId, args.skuId);
  }

  /** Increment on_hand (intake, trade-in, refund). */
  async receive(args: {
    storeId: string;
    skuId: string;
    locationId: string;
    qty: number;
    costCents?: number;
  }): Promise<void> {
    await this.db
      .insert(schema.inventory)
      .values({
        skuId: args.skuId,
        locationId: args.locationId,
        qtyOnHand: args.qty,
        qtyReserved: 0,
        costAvgCents: args.costCents ?? 0,
      })
      .onConflictDoUpdate({
        target: [schema.inventory.skuId, schema.inventory.locationId],
        set: {
          qtyOnHand: sql`${schema.inventory.qtyOnHand} + ${args.qty}`,
          // Weighted moving average cost.
          costAvgCents: sql`case
              when ${schema.inventory.qtyOnHand} + ${args.qty} = 0 then 0
              else round(
                (${schema.inventory.costAvgCents} * ${schema.inventory.qtyOnHand}
                  + coalesce(${args.costCents ?? 0}, 0) * ${args.qty})
                / (${schema.inventory.qtyOnHand} + ${args.qty})
              )::int
            end`,
          updatedAt: new Date(),
        },
      });
    this.emitUpdated(args.storeId, args.skuId);
  }

  private async emitUpdated(storeId: string, skuId: string) {
    const [row] = await this.db
      .select({
        qtyOnHand: sql<number>`sum(${schema.inventory.qtyOnHand})`.as('qty_on_hand'),
        qtyReserved: sql<number>`sum(${schema.inventory.qtyReserved})`.as('qty_reserved'),
      })
      .from(schema.inventory)
      .where(eq(schema.inventory.skuId, skuId));
    const [price] = await this.db
      .select({ marketPriceCents: schema.currentPrices.marketPriceCents })
      .from(schema.currentPrices)
      .where(eq(schema.currentPrices.skuId, skuId));
    this.realtime.emitToStore(storeId, SOCKET_EVENTS.inventoryUpdated, {
      skuId,
      qtyOnHand: row?.qtyOnHand ?? 0,
      qtyReserved: row?.qtyReserved ?? 0,
      marketPriceCents: price?.marketPriceCents ?? null,
    });
  }
}
