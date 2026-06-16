import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import type { ConfigService } from './config-service';
import { PkmnCardsClient } from '../../integrations/pkmncards/client';

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

/**
 * Safety guardrails for background runs. The old fixed 1000-batch loop could
 * burn through API quotas when candidate rows never become enrichable.
 */
const MAX_BACKGROUND_BATCHES_ABSOLUTE = 200;
const STAGNANT_BATCH_LIMIT = 3;

/**
 * In-memory set of (storeId, scope) tuples currently being processed by a
 * background runner. Prevents the same scope from being kicked off twice.
 */
const BACKGROUND_RUNS = new Set<string>();

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
    const limit = ENRICH_BATCH_SIZE;

    // Pick products that still need enrichment. Either no tcgapi mapping yet,
    // or (if onlyMissingImage) just no image. Skip games where tcgapi has no
    // catalogue (sealed/supplies/other). Only process products with actual inventory.
    const where = and(
      eq(schema.products.storeId, args.storeId),
      sql`${schema.products.game} not in ('sealed','supplies','other')`,
      args.onlyMissingImage
        ? or(
            isNull(schema.products.imageSourceUrl),
            eq(schema.products.imageSourceUrl, ''),
          )
        : or(
            isNull(schema.products.tcgapiProductId),
            isNull(schema.products.imageSourceUrl),
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
        tcgapiProductId: schema.products.tcgapiProductId,
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
        schema.products.tcgapiProductId,
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

    const result: EnrichResult = {
      scanned: candidates.length,
      matched: 0,
      imagesUpdated: 0,
      matches: [],
      unmatched: [],
      remaining: Math.max(0, totalToDo - candidates.length),
    };

    for (const p of candidates) {
      try {
        const match = await this.findBestMatch(p);
        if (!match) {
          result.unmatched.push({ productId: p.id, name: p.name, reason: 'no match' });
          await sleep(60);
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
        }
      } catch (err) {
        result.unmatched.push({
          productId: p.id,
          name: p.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(60); // gentle rate limit
    }

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
            return;
          }

          if (madePendingProgress || madeImageProgress) {
            stagnantBatches = 0;
          } else {
            stagnantBatches += 1;
          }

          if (stagnantBatches >= STAGNANT_BATCH_LIMIT) {
            // eslint-disable-next-line no-console
            console.warn('[enrichment] stopping background run after repeated no-progress batches', {
              storeId: args.storeId,
              onlyMissingImage: !!args.onlyMissingImage,
              stagnantBatches,
              pendingBefore,
              pendingAfter,
            });
            return;
          }

          pendingBefore = pendingAfter;
        }

        // eslint-disable-next-line no-console
        console.warn('[enrichment] stopping background run after reaching batch safety cap', {
          storeId: args.storeId,
          onlyMissingImage: !!args.onlyMissingImage,
          maxBatches,
          pendingRemaining: pendingBefore,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[enrichment] background batch failed', err);
      } finally {
        BACKGROUND_RUNS.delete(key);
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
      sql`${schema.products.game} not in ('sealed','supplies','other')`,
      args.onlyMissingImage
        ? or(isNull(schema.products.imageSourceUrl), eq(schema.products.imageSourceUrl, ''))
        : or(
            isNull(schema.products.tcgapiProductId),
            isNull(schema.products.imageSourceUrl),
          ),
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
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
