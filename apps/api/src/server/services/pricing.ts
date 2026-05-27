import { eq, sql } from 'drizzle-orm';
import type { PriceSource } from '@tcg/shared';
import { schema, type Database } from '../../db/client';

export class PricingService {
  constructor(private readonly db: Database) {}

  async getCurrent(skuId: string) {
    const [row] = await this.db
      .select()
      .from(schema.currentPrices)
      .where(eq(schema.currentPrices.skuId, skuId));
    return row ?? null;
  }

  async recordSnapshot(args: {
    skuId: string;
    source: PriceSource;
    priceCents: number;
    sampleSize?: number;
  }): Promise<void> {
    await this.db.insert(schema.priceSnapshots).values({
      skuId: args.skuId,
      source: args.source,
      priceCents: args.priceCents,
      sampleSize: args.sampleSize,
    });
  }

  /**
   * Recompute the effective `current_prices` row from the most recent snapshot
   * per source for this SKU. `manual_override` always wins; otherwise sell
   * price = max(market, mid) so we never sell below what the market will bear.
   * Buy price defaults to half-market (the trade-in service can override).
   */
  async recomputeCurrent(skuId: string): Promise<void> {
    await this.db.execute(sql`
      with latest as (
        select distinct on (source)
          source, price_cents
        from price_snapshots
        where sku_id = ${skuId}
        order by source, captured_at desc
      ),
      pivot as (
        select
          (select price_cents from latest where source = 'tcgapi_market') as market,
          (select price_cents from latest where source = 'tcgapi_mid')    as mid,
          (select price_cents from latest where source = 'tcgapi_low')    as low,
          (select price_cents from latest where source = 'manual_override') as override
      )
      insert into current_prices (sku_id, sell_price_cents, buy_price_cents, market_price_cents, market_median_cents, updated_at)
      select
        ${skuId},
        coalesce(p.override, greatest(coalesce(p.market, 0), coalesce(p.mid, 0))),
        floor(coalesce(p.low, p.market, p.mid, 0) * 0.5)::int,
        p.market,
        p.mid,
        now()
      from pivot p
      on conflict (sku_id) do update set
        sell_price_cents = excluded.sell_price_cents,
        buy_price_cents = excluded.buy_price_cents,
        market_price_cents = excluded.market_price_cents,
        market_median_cents = excluded.market_median_cents,
        updated_at = now()
    `);
  }
}
