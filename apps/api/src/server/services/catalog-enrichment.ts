import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import type { ConfigService } from './config-service';
import { PkmnCardsClient } from '../../integrations/pkmncards/client';
import { getLogger } from '../../common/logger';

export interface EnrichMatched {
  productId: string;
  name: string;
  setName: string | null;
  cardNumber: string | null;
  imageSourceUrl: string | null;
  tcgapiProductId: string | null;
  source: 'pkmncards';
}

interface EnrichMatch {
  source: 'pkmncards';
  tcgapiProductId: string | null;
  imageUrl: string | null;
  lookupMethod: 'deterministic' | 'search';
  cardUrl: string | null;
}

export interface EnrichResult {
  scanned: number;
  matched: number;
  imagesUpdated: number;
  matches: EnrichMatched[];
  unmatched: Array<{ productId: string; name: string; reason: string }>;
  remaining: number;
}

/** Manual enrichment batch size per click/run. */
export const ENRICH_BATCH_SIZE = 50;
const ENRICH_ROW_DELAY_MS = 10;

/**
 * Safety guardrails for background runs. The old fixed 1000-batch loop could
 * burn through API quotas when candidate rows never become enrichable.
 */
const MAX_BACKGROUND_BATCHES_ABSOLUTE = 200;
const STAGNANT_BATCH_LIMIT = 3;
const UNMATCHED_SAMPLE_LIMIT = 10;
const REASON_MAX_LEN = 220;

/**
 * In-memory set of (storeId, scope) tuples currently being processed by a
 * background runner. Prevents the same scope from being kicked off twice.
 */
const BACKGROUND_RUNS = new Set<string>();
const logger = getLogger();

export class CatalogEnrichmentService {
  private readonly pkmnCards = new PkmnCardsClient();

  constructor(
    private readonly db: Database,
    private readonly configs: ConfigService,
  ) {}

  async enrichStore(args: {
    storeId: string;
    onlyMissingImage?: boolean;
  }): Promise<EnrichResult> {
    const startedAt = Date.now();
    const limit = ENRICH_BATCH_SIZE;

    // Pick only Pokemon products missing images. Image backfill is PkmnCards-only.
    const where = and(
      eq(schema.products.storeId, args.storeId),
      eq(schema.products.game, 'pokemon'),
      or(
        isNull(schema.products.imageSourceUrl),
        eq(schema.products.imageSourceUrl, ''),
      ),
    );

    const candidates = await this.db
      .select({
        id: schema.products.id,
        name: schema.products.name,
        setName: schema.products.setName,
        setId: schema.products.setId,
        cardNumber: schema.products.cardNumber,
        game: schema.products.game,
        imageSourceUrl: schema.products.imageSourceUrl,
      })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(
        and(
          where,
          eq(schema.locations.storeId, args.storeId),
        ),
      )
      .groupBy(
        schema.products.id,
        schema.products.name,
        schema.products.setName,
        schema.products.setId,
        schema.products.cardNumber,
        schema.products.game,
        schema.products.imageSourceUrl,
      )
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .limit(limit);

    const remainingRows = await this.db
      .select({ n: sql<number>`count(distinct ${schema.products.id})::int` })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(
        and(
          where,
          eq(schema.locations.storeId, args.storeId),
        ),
      )
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`);
    const totalToDo = Number(remainingRows[0]?.n ?? 0);

    logger.info(
      {
        storeId: args.storeId,
        onlyMissingImage: !!args.onlyMissingImage,
        batchSize: limit,
        pendingBefore: totalToDo,
        scanned: candidates.length,
      },
      '[enrichment] backfill batch start',
    );

    const result: EnrichResult = {
      scanned: candidates.length,
      matched: 0,
      imagesUpdated: 0,
      matches: [],
      unmatched: [],
      remaining: Math.max(0, totalToDo - candidates.length),
    };

    for (const p of candidates) {
      const lookupInput = {
        productId: p.id,
        name: p.name,
        setName: p.setName,
        setCode: p.setId,
        cardNumber: p.cardNumber,
      };
      try {
        logger.debug(
          { storeId: args.storeId, ...lookupInput },
          '[enrichment] lookup start',
        );

        const match = await this.findBestMatch(p);
        if (!match) {
          result.unmatched.push({ productId: p.id, name: p.name, reason: 'no match' });
          logger.debug(
            { storeId: args.storeId, ...lookupInput, reason: 'no match' },
            '[enrichment] lookup miss',
          );
          await sleep(ENRICH_ROW_DELAY_MS);
          continue;
        }

        const patch: Record<string, unknown> = { updatedAt: new Date() };
        const newImage = match.imageUrl && !p.imageSourceUrl ? match.imageUrl : null;
        if (newImage) {
          patch.imageSourceUrl = newImage;
          result.imagesUpdated++;
        }
        if (Object.keys(patch).length > 1) {
          await this.db
            .update(schema.products)
            .set(patch)
            .where(eq(schema.products.id, p.id));
          result.matched++;
          result.matches.push({
            productId: p.id,
            name: p.name,
            setName: p.setName,
            cardNumber: p.cardNumber,
            imageSourceUrl: newImage ?? p.imageSourceUrl ?? null,
            tcgapiProductId: null,
            source: match.source,
          });
          logger.debug(
            {
              storeId: args.storeId,
              ...lookupInput,
              source: match.source,
              lookupMethod: match.lookupMethod,
              cardUrl: match.cardUrl,
              imageUrl: newImage,
            },
            '[enrichment] lookup hit',
          );
        } else {
          logger.debug(
            {
              storeId: args.storeId,
              ...lookupInput,
              source: match.source,
              lookupMethod: match.lookupMethod,
              cardUrl: match.cardUrl,
              reason: 'match found but no image update needed',
            },
            '[enrichment] lookup skipped update',
          );
        }
      } catch (err) {
        const reason = toReason(err);
        result.unmatched.push({
          productId: p.id,
          name: p.name,
          reason,
        });
        logger.warn(
          { storeId: args.storeId, ...lookupInput, reason },
          '[enrichment] lookup error',
        );
      }
      await sleep(ENRICH_ROW_DELAY_MS); // gentle rate limit
    }

    logger.info(
      {
        storeId: args.storeId,
        onlyMissingImage: !!args.onlyMissingImage,
        durationMs: Date.now() - startedAt,
        scanned: result.scanned,
        matched: result.matched,
        imagesUpdated: result.imagesUpdated,
        remaining: result.remaining,
        unmatchedCount: result.unmatched.length,
        unmatchedByReason: summarizeUnmatchedReasons(result.unmatched),
        unmatchedSample: result.unmatched.slice(0, UNMATCHED_SAMPLE_LIMIT),
      },
      '[enrichment] backfill batch complete',
    );

    return result;
  }

  /**
   * Fire-and-forget loop that drains all enrichment work in batches of
   * `ENRICH_BATCH_SIZE`. Errors are swallowed (logged) so callers can
   * trigger this without awaiting.
   */
  runInBackground(args: { storeId: string; onlyMissingImage?: boolean }): void {
    const key = `${args.storeId}:${args.onlyMissingImage ? 'img' : 'all'}`;
    if (BACKGROUND_RUNS.has(key)) return; // already running for this scope

    logger.info(
      { storeId: args.storeId, onlyMissingImage: !!args.onlyMissingImage },
      '[enrichment] background run start',
    );

    BACKGROUND_RUNS.add(key);
    void (async () => {
      try {
        let pendingBefore = await this.pendingCount(args);
        if (pendingBefore === 0) return;

        // Dynamic cap based on outstanding work plus a small retry cushion.
        const maxBatches = Math.min(
          MAX_BACKGROUND_BATCHES_ABSOLUTE,
          Math.max(1, Math.ceil(pendingBefore / ENRICH_BATCH_SIZE) + 10),
        );

        let stagnantBatches = 0;
        for (let i = 0; i < maxBatches; i++) {
          const r = await this.enrichStore(args);

          const pendingAfter = await this.pendingCount(args);
          const madePendingProgress = pendingAfter < pendingBefore;
          const madeImageProgress = r.imagesUpdated > 0;

          if (pendingAfter === 0 || r.scanned === 0) {
            logger.info(
              {
                storeId: args.storeId,
                onlyMissingImage: !!args.onlyMissingImage,
                pendingAfter,
                scanned: r.scanned,
              },
              '[enrichment] background run finished naturally',
            );
            return;
          }

          if (madePendingProgress || madeImageProgress) {
            stagnantBatches = 0;
          } else {
            stagnantBatches += 1;
          }

          if (stagnantBatches >= STAGNANT_BATCH_LIMIT) {
            logger.warn(
              {
                storeId: args.storeId,
                onlyMissingImage: !!args.onlyMissingImage,
                stagnantBatches,
                pendingBefore,
                pendingAfter,
              },
              '[enrichment] stopping background run after repeated no-progress batches',
            );
            return;
          }

          pendingBefore = pendingAfter;
        }

        logger.warn(
          {
            storeId: args.storeId,
            onlyMissingImage: !!args.onlyMissingImage,
            maxBatches,
            pendingRemaining: pendingBefore,
          },
          '[enrichment] stopping background run after reaching batch safety cap',
        );
      } catch (err) {
        logger.error(
          {
            storeId: args.storeId,
            onlyMissingImage: !!args.onlyMissingImage,
            err: err instanceof Error ? err.message : String(err),
          },
          '[enrichment] background batch failed',
        );
      } finally {
        BACKGROUND_RUNS.delete(key);
        logger.info(
          { storeId: args.storeId, onlyMissingImage: !!args.onlyMissingImage },
          '[enrichment] background run end',
        );
      }
    })();
  }

  isRunning(args: { storeId: string; onlyMissingImage?: boolean }): boolean {
    return BACKGROUND_RUNS.has(`${args.storeId}:${args.onlyMissingImage ? 'img' : 'all'}`);
  }

  /** Count of products that still need enrichment under the given filter. Only counts products with inventory. */
  async pendingCount(args: {
    storeId: string;
    onlyMissingImage?: boolean;
  }): Promise<number> {
    const where = and(
      eq(schema.products.storeId, args.storeId),
      eq(schema.products.game, 'pokemon'),
      or(isNull(schema.products.imageSourceUrl), eq(schema.products.imageSourceUrl, '')),
    );
    const [row] = await this.db
      .select({ n: sql<number>`count(distinct ${schema.products.id})::int` })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(
        and(
          where,
          eq(schema.locations.storeId, args.storeId),
        ),
      )
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`);
    return Number(row?.n ?? 0);
  }

  private async findBestMatch(p: {
    name: string;
    setName: string | null;
    setId: string | null;
    cardNumber: string | null;
    game: string;
    imageSourceUrl: string | null;
  }): Promise<EnrichMatch | null> {
    // Image sourcing is intentionally PkmnCards-only.
    if (p.game !== 'pokemon' || p.imageSourceUrl) return null;

    const pkmn = await this.pkmnCards.lookup({
      name: p.name,
      setCode: p.setId,
      setName: p.setName,
      cardNumber: p.cardNumber,
    });
    if (!pkmn?.imageUrl) return null;

    return {
      source: 'pkmncards',
      tcgapiProductId: null,
      imageUrl: pkmn.imageUrl,
      lookupMethod: pkmn.method,
      cardUrl: pkmn.cardUrl,
    };
  }
}

function toReason(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return reason.length > REASON_MAX_LEN ? `${reason.slice(0, REASON_MAX_LEN)}...` : reason;
}

function summarizeUnmatchedReasons(unmatched: Array<{ reason: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of unmatched) {
    const key = row.reason || 'unknown';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
