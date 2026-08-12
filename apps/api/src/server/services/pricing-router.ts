/**
 * Language-aware pricing router. Given a SKU, prices Pokémon cards from
 * PkmnPrices (ungraded market or graded eBay sold comps) and writes a snapshot
 * + threshold-guarded `current_prices` refresh. Non-Pokémon SKUs are
 * manual-only and rely on any `manual_override` snapshot.
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
  aggregateGradedMedianCents,
  pickBestTcgplayerPrice,
  PkmnPricesClient,
} from '../../integrations/pkmnprices/client';
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

      const { source, marketCents, lowCents, sampleSize } = providerResult;
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

      await this.pricing.recordSnapshot({ skuId, source, priceCents: nextCents, sampleSize });
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
        condition: schema.skus.condition,
        printing: schema.skus.printing,
        language: schema.skus.language,
        gradingCompany: schema.skus.gradingCompany,
        grade: schema.skus.grade,
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
      condition: row.condition,
      language: row.language,
      printing: row.printing,
      gradingCompany: row.gradingCompany,
      grade: row.grade,
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

        // Graded SKUs price off eBay sold comps for the specific grader + grade,
        // not the raw TCGplayer market figure.
        if (ctx.gradingCompany && ctx.grade) {
          const sales = await client.getGradedEbaySales(ctx.pkmnpricesCardId, {
            grader: gradingCompanyToGrader(ctx.gradingCompany),
            grade: ctx.grade,
            sinceDays: GRADED_WINDOW_DAYS,
            maxItems: 40,
          });
          const agg = aggregateGradedMedianCents(sales, { minSample: GRADED_MIN_SAMPLE });
          // Thin sample: leave the SKU on its manual Override (no automated price).
          if (!agg) return null;
          return {
            source: 'pkmnprices_graded_ebay',
            marketCents: agg.medianCents,
            lowCents: null,
            sampleSize: agg.sampleSize,
          };
        }

        const prices = await client.getCardPrices(ctx.pkmnpricesCardId);
        const best = pickBestTcgplayerPrice(prices, {
          condition: conditionEnumToLabel(ctx.condition),
          printing: ctx.printing,
        });
        if (best?.marketCents) {
          return {
            source: 'pkmnprices_market',
            marketCents: best.marketCents,
            lowCents: null,
          };
        }
      }
    }

    // Non-Pokémon SKUs (and Pokémon without a PkmnPrices id) are manual-only:
    // no automatic price provider, so pricing falls back to any manual override.
    return null;
  }
}

// ---- helpers -------------------------------------------------------------

interface SkuContext {
  skuId: string;
  storeId: string;
  condition: string | null;
  language: string;
  printing: string;
  gradingCompany: string | null;
  grade: string | null;
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
  sampleSize?: number;
}

/** Rolling window and minimum sample for trusting a graded eBay median. */
const GRADED_WINDOW_DAYS = 90;
const GRADED_MIN_SAMPLE = 3;

/** SKU grading-company enum → PriceCharting/eBay grader filter string. */
function gradingCompanyToGrader(company: string): string {
  switch (company) {
    case 'psa':
      return 'PSA';
    case 'cgc':
      return 'CGC';
    case 'beckett':
      return 'BGS';
    case 'sgc':
      return 'SGC';
    case 'tag':
      return 'TAG';
    default:
      return company.toUpperCase();
  }
}

/** In-house condition enum → TCGplayer-style label used in the price feed. */
function conditionEnumToLabel(condition: string | null): string | undefined {
  switch (condition) {
    case 'NM':
      return 'Near Mint';
    case 'LP':
      return 'Lightly Played';
    case 'MP':
      return 'Moderately Played';
    case 'HP':
      return 'Heavily Played';
    case 'DMG':
      return 'Damaged';
    default:
      return undefined;
  }
}

// Silence "isNotNull unused" — used in future queries; keeps drizzle-orm import stable.
void isNotNull;
