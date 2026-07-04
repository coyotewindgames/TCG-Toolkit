/**
 * Language-aware pricing router. Given a SKU, picks a provider (PkmnPrices
 * primary → tcgapi fallback for non-Pokémon), fetches the latest per-printing
 * market price, and writes a snapshot + threshold-guarded `current_prices`
 * refresh.
 *
 * Threshold policy: if the new market cents differs from the previous
 * `current_prices.market_price_cents` by less than 0.5% AND there is no
 * `manual_override` snapshot for this SKU, we intentionally skip writing the
 * snapshot AND recomputing `current_prices`. Nightly runs used to churn ~40
 * MB of no-op writes per store; this pushes that to zero without losing real
 * price movements.
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { PriceSource } from '@tcg/shared';
import { getLogger } from '../../common/logger';
import { schema, type Database } from '../../db/client';
import {
  pickBestTcgplayerPrice,
  PkmnPricesClient,
} from '../../integrations/pkmnprices/client';
import { TcgapiClient } from '../../integrations/tcgapi/client';
import { ConfigService } from './config-service';
import { PricingService } from './pricing';

export type RefreshAction = 'wrote' | 'skipped' | 'no_data' | 'no_id' | 'no_provider' | 'error';

export interface RefreshResult {
  skuId: string;
  action: RefreshAction;
  source?: PriceSource;
  prevCents: number | null;
  nextCents: number | null;
  err?: string;
}

/** Absolute pct threshold — writes are suppressed if |Δ| / prev is below this. */
const CHANGE_THRESHOLD = 0.005;

export class PricingRouter {
  private readonly log = getLogger();

  constructor(
    private readonly db: Database,
    private readonly configs: ConfigService,
    private readonly pricing: PricingService,
  ) {}

  /** Refresh a single SKU. Chooses provider based on SKU language + store tier. */
  async refreshSkuPrice(skuId: string): Promise<RefreshResult> {
    const ctx = await this.loadContext(skuId);
    if (!ctx) return { skuId, action: 'no_id', prevCents: null, nextCents: null };

    try {
      const providerResult = await this.fetchFromBestProvider(ctx);
      if (!providerResult) {
        return {
          skuId,
          action: 'no_provider',
          prevCents: ctx.prevMarketCents,
          nextCents: null,
        };
      }

      const { source, marketCents, lowCents } = providerResult;
      const prev = ctx.prevMarketCents;
      const nextCents = marketCents;

      if (prev != null && prev > 0 && !ctx.hasOverride) {
        const delta = Math.abs(nextCents - prev) / prev;
        if (delta < CHANGE_THRESHOLD) {
          this.log.info(
            { skuId, prevCents: prev, nextCents, delta, source, action: 'skipped' },
            'pricing.refresh: within threshold, skipped',
          );
          return { skuId, action: 'skipped', source, prevCents: prev, nextCents };
        }
      }

      await this.pricing.recordSnapshot({ skuId, source, priceCents: nextCents });
      if (lowCents != null) {
        const lowSource: PriceSource =
          source === 'pkmnprices_market' ? 'pkmnprices_low' : 'tcgapi_low';
        await this.pricing.recordSnapshot({ skuId, source: lowSource, priceCents: lowCents });
      }
      await this.pricing.recomputeCurrent(skuId);

      this.log.info(
        { skuId, prevCents: prev, nextCents, source, action: 'wrote' },
        'pricing.refresh: wrote',
      );
      return { skuId, action: 'wrote', source, prevCents: prev, nextCents };
    } catch (err) {
      const message = (err as Error).message;
      this.log.error({ skuId, err: message, action: 'error' }, 'pricing.refresh: error');
      return { skuId, action: 'error', prevCents: ctx.prevMarketCents, nextCents: null, err: message };
    }
  }

  // ---- internal ----------------------------------------------------------

  private async loadContext(skuId: string): Promise<SkuContext | null> {
    const [row] = await this.db
      .select({
        skuId: schema.skus.id,
        storeId: schema.skus.storeId,
        printing: schema.skus.printing,
        language: schema.skus.language,
        tcgapiId: schema.products.tcgapiProductId,
        pkmnpricesId: schema.products.pkmnpricesProductId,
        game: schema.products.game,
      })
      .from(schema.skus)
      .innerJoin(schema.products, eq(schema.products.id, schema.skus.productId))
      .where(eq(schema.skus.id, skuId))
      .limit(1);
    if (!row) return null;

    const [current] = await this.db
      .select({ marketCents: schema.currentPrices.marketPriceCents })
      .from(schema.currentPrices)
      .where(eq(schema.currentPrices.skuId, skuId))
      .limit(1);

    const [override] = await this.db
      .select({ id: schema.priceSnapshots.id })
      .from(schema.priceSnapshots)
      .where(
        and(
          eq(schema.priceSnapshots.skuId, skuId),
          eq(schema.priceSnapshots.source, 'manual_override'),
        ),
      )
      .orderBy(desc(schema.priceSnapshots.capturedAt))
      .limit(1);

    return {
      skuId,
      storeId: row.storeId,
      language: row.language,
      printing: row.printing,
      game: row.game,
      tcgapiCardId: row.tcgapiId,
      pkmnpricesCardId: row.pkmnpricesId,
      prevMarketCents: current?.marketCents ?? null,
      hasOverride: !!override,
    };
  }

  private async fetchFromBestProvider(ctx: SkuContext): Promise<ProviderPrice | null> {
    // Only Pokémon SKUs are candidates for the PkmnPrices path.
    const isPokemon = ctx.game === 'pokemon';
    const pkStatus = await this.configs.getPkmnpricesStatus(ctx.storeId).catch(() => null);

    if (isPokemon && ctx.pkmnpricesCardId && pkStatus?.configured && pkStatus.hasKey) {
      // JP prices require the Pro tier per PkmnPrices docs.
      const canQueryJp = pkStatus.tier === 'pro' || pkStatus.tier === 'business';
      if (ctx.language !== 'JP' || canQueryJp) {
        const creds = await this.configs.getPkmnprices(ctx.storeId);
        const client = new PkmnPricesClient({ apiKey: creds.apiKey });
        const prices = await client.getCardPrices(ctx.pkmnpricesCardId);
        const best = pickBestTcgplayerPrice(prices, { condition: 'NM', printing: ctx.printing });
        if (best?.marketCents) {
          return {
            source: 'pkmnprices_market',
            marketCents: best.marketCents,
            lowCents: null,
          };
        }
      }
    }

    // Fallback: TCGapi (non-Pokémon SKUs, or Pokémon SKUs without a PkmnPrices id).
    if (ctx.tcgapiCardId) {
      const tcgapiStatus = await this.configs.getTcgapiStatus(ctx.storeId).catch(() => null);
      if (!tcgapiStatus?.configured || !tcgapiStatus.hasKey) return null;
      const creds = await this.configs.getTcgapi(ctx.storeId);
      const client = new TcgapiClient({ baseUrl: creds.baseUrl, apiKey: creds.apiKey });
      const rows = await client.getCardPrices(ctx.tcgapiCardId);
      const row = rows.find((r) => tcgapiPrintingToEnum(r.printing) === ctx.printing) ?? rows[0];
      if (!row?.marketCents) return null;
      return {
        source: 'tcgapi_market',
        marketCents: row.marketCents,
        lowCents: row.lowCents ?? null,
      };
    }

    return null;
  }
}

// ---- helpers -------------------------------------------------------------

interface SkuContext {
  skuId: string;
  storeId: string;
  language: string;
  printing: string;
  game: string;
  tcgapiCardId: string | null;
  pkmnpricesCardId: number | null;
  prevMarketCents: number | null;
  hasOverride: boolean;
}

interface ProviderPrice {
  source: PriceSource;
  marketCents: number;
  lowCents: number | null;
}

function tcgapiPrintingToEnum(label: string | null | undefined): string {
  const normalized = (label ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return 'Normal';
  if (normalized.includes('reverseholo') || normalized === 'reverse' || normalized === 'rh') return 'Reverse';
  if (normalized.includes('1stedition') || normalized.includes('firstedition')) return 'FirstEdition';
  if (normalized.includes('holo')) return 'Holo';
  if (normalized.includes('foil') && !normalized.includes('non')) return 'Foil';
  return 'Normal';
}

// Silence "isNotNull unused" — used in future queries; keeps drizzle-orm import stable.
void isNotNull;
