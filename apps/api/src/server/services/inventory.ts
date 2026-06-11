import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { Conflict, NotFound } from '../../common/http-errors';
import { emitToStore, SOCKET_EVENTS } from '../realtime/socket';

/**
 * Inventory mutations.
 *
 * All quantity changes go through here so we can enforce row-level locking
 * (`SELECT ... FOR UPDATE`) and emit `inventory.updated` events.
 */
export class InventoryService {
  constructor(private readonly db: Database) {}

  async findReservableLocation(args: {
    storeId: string;
    skuId: string;
    preferredLocationId: string;
    qty: number;
  }): Promise<string | null> {
    const rows = await this.db
      .select({
        locationId: schema.inventory.locationId,
        qtyOnHand: schema.inventory.qtyOnHand,
        qtyReserved: schema.inventory.qtyReserved,
      })
      .from(schema.inventory)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(
        and(
          eq(schema.inventory.skuId, args.skuId),
          eq(schema.locations.storeId, args.storeId),
        ),
      )
      .orderBy(
        desc(sql<number>`case when ${schema.inventory.locationId} = ${args.preferredLocationId} then 1 else 0 end`),
        desc(sql<number>`${schema.inventory.qtyOnHand} - ${schema.inventory.qtyReserved}`),
      );

    const reservable = rows.filter((row) => row.qtyOnHand - row.qtyReserved >= args.qty);
    return reservable[0]?.locationId ?? null;
  }

  async reserve(args: {
    storeId: string;
    skuId: string;
    locationId: string;
    qty: number;
  }): Promise<void> {
    if (args.qty <= 0) throw Conflict('qty must be positive');
    await this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        select qty_on_hand, qty_reserved
        from inventory
        where sku_id = ${args.skuId} and location_id = ${args.locationId}
        for update
      `);
      const row = (rows.rows as Array<{ qty_on_hand: number; qty_reserved: number }>)[0];
      if (!row) throw NotFound('inventory row not found');
      const available = row.qty_on_hand - row.qty_reserved;
      if (available < args.qty) {
        throw Conflict(`only ${available} available`);
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
    await this.emitUpdated(args.storeId, args.skuId);
  }

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
    await this.emitUpdated(args.storeId, args.skuId);
  }

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
    await this.emitUpdated(args.storeId, args.skuId);
  }

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
    await this.emitUpdated(args.storeId, args.skuId);
  }

    async summary(storeId: string): Promise<{
      estimatedCostCents: number;
      qtyOnHand: number;
      skuCount: number;
    }> {
      const [row] = await this.db
        .select({
          estimatedCostCents:
            sql<number>`coalesce(sum(${schema.inventory.qtyOnHand} * ${schema.inventory.costAvgCents}), 0)`.as(
              'estimated_cost_cents',
            ),
          qtyOnHand: sql<number>`coalesce(sum(${schema.inventory.qtyOnHand}), 0)`.as('qty_on_hand'),
          skuCount: sql<number>`count(*)::int`.as('sku_count'),
        })
        .from(schema.inventory)
        .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
        .where(eq(schema.locations.storeId, storeId));

      return {
        estimatedCostCents: Number(row?.estimatedCostCents ?? 0),
        qtyOnHand: Number(row?.qtyOnHand ?? 0),
        skuCount: Number(row?.skuCount ?? 0),
      };
    }

  private async emitUpdated(storeId: string, skuId: string): Promise<void> {
    const [row] = await this.db
      .select({
        qtyOnHand: sql<number>`coalesce(sum(${schema.inventory.qtyOnHand}), 0)`.as('qty_on_hand'),
        qtyReserved: sql<number>`coalesce(sum(${schema.inventory.qtyReserved}), 0)`.as(
          'qty_reserved',
        ),
      })
      .from(schema.inventory)
      .where(eq(schema.inventory.skuId, skuId));
    const [price] = await this.db
      .select({ marketPriceCents: schema.currentPrices.marketPriceCents })
      .from(schema.currentPrices)
      .where(eq(schema.currentPrices.skuId, skuId));
    emitToStore(storeId, SOCKET_EVENTS.inventoryUpdated, {
      skuId,
      qtyOnHand: row?.qtyOnHand ?? 0,
      qtyReserved: row?.qtyReserved ?? 0,
      marketPriceCents: price?.marketPriceCents ?? null,
    });
  }
}
