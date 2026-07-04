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
   * price prefers the freshest PkmnPrices market (primary source), falls back
   * to tcgapi_market, and finally to any low/median snapshot. Buy price
   * defaults to the buylist snapshot when present, else half of the lowest
   * live price (the trade-in service can override).
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
          (select price_cents from latest where source = 'pkmnprices_market')  as pk_market,
          (select price_cents from latest where source = 'pkmnprices_low')     as pk_low,
          (select price_cents from latest where source = 'tcgapi_market')      as tcg_market,
          (select price_cents from latest where source = 'tcgapi_median')      as tcg_median,
          (select price_cents from latest where source = 'tcgapi_low')         as tcg_low,
          (select price_cents from latest where source = 'tcgapi_buylist')     as tcg_buylist,
          (select price_cents from latest where source = 'manual_override')    as override
      )
      insert into current_prices (sku_id, sell_price_cents, buy_price_cents, market_price_cents, market_median_cents, updated_at)
      select
        ${skuId},
        coalesce(p.override, p.pk_market, p.tcg_market, p.tcg_median, p.pk_low, p.tcg_low, 0),
        coalesce(p.tcg_buylist, floor(coalesce(p.pk_low, p.tcg_low, p.pk_market, p.tcg_market, p.tcg_median, 0) * 0.5)::int),
        coalesce(p.pk_market, p.tcg_market),
        p.tcg_median,
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
