import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PriceSource } from '@tcg/shared';
import { DRIZZLE } from '../../db/database.module';
import { schema } from '../../db/client';
import type { Database } from '../../db/client';

@Injectable()
export class PricingService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

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
   * per source for this SKU. Sell price = max(market, ebay_30d_median) — never
   * sell below what the market will bear; buy price = min * tier_multiplier
   * (set elsewhere in the trade-in service).
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
          (select price_cents from latest where source = 'tcgplayer_market') as market,
          (select price_cents from latest where source = 'ebay_30d_median')  as ebay30,
          (select price_cents from latest where source = 'manual_override')  as override
      )
      insert into current_prices (sku_id, sell_price_cents, buy_price_cents, market_price_cents, ebay_30d_median_cents, updated_at)
      select
        ${skuId},
        coalesce(p.override, greatest(coalesce(p.market, 0), coalesce(p.ebay30, 0))),
        floor(coalesce(p.market, p.ebay30, 0) * 0.5)::int,
        p.market,
        p.ebay30,
        now()
      from pivot p
      on conflict (sku_id) do update set
        sell_price_cents = excluded.sell_price_cents,
        buy_price_cents = excluded.buy_price_cents,
        market_price_cents = excluded.market_price_cents,
        ebay_30d_median_cents = excluded.ebay_30d_median_cents,
        updated_at = now()
    `);
  }
}
