import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

export class AnalyticsService {
  constructor(private readonly db: Database) {}

  async summary(storeId: string, range: AnalyticsRange) {
    const [sales] = await this.db
      .select({
        transactionCount: sql<number>`count(*)::int`,
        totalSalesCents: sql<number>`coalesce(sum(${schema.orders.totalCents}), 0)::int`,
        averageTransactionCents: sql<number>`coalesce(avg(${schema.orders.totalCents}), 0)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.storeId, storeId),
          eq(schema.orders.status, 'paid'),
          gte(sql`coalesce(${schema.orders.closedAt}, ${schema.orders.createdAt})`, range.from),
          lte(sql`coalesce(${schema.orders.closedAt}, ${schema.orders.createdAt})`, range.to),
        ),
      );

    const [trade] = await this.db
      .select({
        tradeCount: sql<number>`count(*)::int`,
        tradeValueCents: sql<number>`coalesce(sum(${schema.tradeIns.totalValueCents}), 0)::int`,
        tradeItemsQty: sql<number>`coalesce(sum(${schema.tradeItems.quantity}), 0)::int`,
      })
      .from(schema.tradeIns)
      .leftJoin(schema.tradeItems, eq(schema.tradeItems.tradeId, schema.tradeIns.id))
      .where(
        and(
          eq(schema.tradeIns.storeId, storeId),
          eq(schema.tradeIns.status, 'completed'),
          gte(sql`coalesce(${schema.tradeIns.completedAt}, ${schema.tradeIns.createdAt})`, range.from),
          lte(sql`coalesce(${schema.tradeIns.completedAt}, ${schema.tradeIns.createdAt})`, range.to),
        ),
      );

    return {
      transactionCount: Number(sales?.transactionCount ?? 0),
      totalSalesCents: Number(sales?.totalSalesCents ?? 0),
      averageTransactionCents: Number(sales?.averageTransactionCents ?? 0),
      tradeCount: Number(trade?.tradeCount ?? 0),
      tradeValueCents: Number(trade?.tradeValueCents ?? 0),
      tradeItemsQty: Number(trade?.tradeItemsQty ?? 0),
    };
  }

  async salesSeries(storeId: string, range: AnalyticsRange) {
    const rows = await this.db
      .select({
        day: sql<string>`to_char(date_trunc('day', coalesce(${schema.orders.closedAt}, ${schema.orders.createdAt})), 'YYYY-MM-DD')`,
        transactions: sql<number>`count(*)::int`,
        totalSalesCents: sql<number>`coalesce(sum(${schema.orders.totalCents}), 0)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.storeId, storeId),
          eq(schema.orders.status, 'paid'),
          gte(sql`coalesce(${schema.orders.closedAt}, ${schema.orders.createdAt})`, range.from),
          lte(sql`coalesce(${schema.orders.closedAt}, ${schema.orders.createdAt})`, range.to),
        ),
      )
      .groupBy(sql`date_trunc('day', coalesce(${schema.orders.closedAt}, ${schema.orders.createdAt}))`)
      .orderBy(sql`date_trunc('day', coalesce(${schema.orders.closedAt}, ${schema.orders.createdAt})) asc`);

    return rows.map((row) => ({
      day: row.day,
      transactions: Number(row.transactions ?? 0),
      totalSalesCents: Number(row.totalSalesCents ?? 0),
    }));
  }

  async tradeinSeries(storeId: string, range: AnalyticsRange) {
    const rows = await this.db
      .select({
        day: sql<string>`to_char(date_trunc('day', coalesce(${schema.tradeIns.completedAt}, ${schema.tradeIns.createdAt})), 'YYYY-MM-DD')`,
        tradeCount: sql<number>`count(distinct ${schema.tradeIns.id})::int`,
        tradeValueCents: sql<number>`coalesce(sum(${schema.tradeIns.totalValueCents}), 0)::int`,
        itemsQty: sql<number>`coalesce(sum(${schema.tradeItems.quantity}), 0)::int`,
      })
      .from(schema.tradeIns)
      .leftJoin(schema.tradeItems, eq(schema.tradeItems.tradeId, schema.tradeIns.id))
      .where(
        and(
          eq(schema.tradeIns.storeId, storeId),
          eq(schema.tradeIns.status, 'completed'),
          gte(sql`coalesce(${schema.tradeIns.completedAt}, ${schema.tradeIns.createdAt})`, range.from),
          lte(sql`coalesce(${schema.tradeIns.completedAt}, ${schema.tradeIns.createdAt})`, range.to),
        ),
      )
      .groupBy(sql`date_trunc('day', coalesce(${schema.tradeIns.completedAt}, ${schema.tradeIns.createdAt}))`)
      .orderBy(sql`date_trunc('day', coalesce(${schema.tradeIns.completedAt}, ${schema.tradeIns.createdAt})) asc`);

    return rows.map((row) => ({
      day: row.day,
      tradeCount: Number(row.tradeCount ?? 0),
      tradeValueCents: Number(row.tradeValueCents ?? 0),
      itemsQty: Number(row.itemsQty ?? 0),
    }));
  }

  async cardsByGame(storeId: string) {
    const rows = await this.db
      .select({
        game: schema.products.game,
        products: sql<number>`count(distinct ${schema.products.id})::int`,
        qtyOnHand: sql<number>`coalesce(sum(${schema.inventory.qtyOnHand}), 0)::int`,
      })
      .from(schema.products)
      .innerJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .innerJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(
        and(
          eq(schema.products.storeId, storeId),
          eq(schema.locations.storeId, storeId),
          gte(schema.inventory.qtyOnHand, 1),
        ),
      )
      .groupBy(schema.products.game)
      .orderBy(sql`coalesce(sum(${schema.inventory.qtyOnHand}), 0) desc`);

    return rows.map((row) => ({
      game: row.game,
      products: Number(row.products ?? 0),
      qtyOnHand: Number(row.qtyOnHand ?? 0),
    }));
  }

  async priceKpis(storeId: string) {
    const [row] = await this.db
      .select({
        avgSellPriceCents: sql<number>`coalesce(avg(${schema.currentPrices.sellPriceCents}), 0)::int`,
        avgMarketPriceCents: sql<number>`coalesce(avg(${schema.currentPrices.marketPriceCents}), 0)::int`,
        pricedSkuCount: sql<number>`count(distinct ${schema.currentPrices.skuId})::int`,
      })
      .from(schema.currentPrices)
      .innerJoin(schema.skus, eq(schema.skus.id, schema.currentPrices.skuId))
      .innerJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(
        and(
          eq(schema.skus.storeId, storeId),
          eq(schema.locations.storeId, storeId),
          gte(schema.inventory.qtyOnHand, 1),
        ),
      );

    return {
      avgSellPriceCents: Number(row?.avgSellPriceCents ?? 0),
      avgMarketPriceCents: Number(row?.avgMarketPriceCents ?? 0),
      pricedSkuCount: Number(row?.pricedSkuCount ?? 0),
    };
  }
}
