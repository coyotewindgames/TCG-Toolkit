/**
 * BullMQ worker. Consumes background jobs that should not block the request
 * path: price refresh from tcgapi.dev, catalog metadata refresh, and webhook
 * retry placeholder.
 *
 * All upstream-calling jobs carry `storeId` because TCGapi credentials live
 * per-store in the encrypted config tables. The client is built on demand via
 * the shared ConfigService cache so back-to-back jobs for the same store
 * don't pay the decrypt cost twice.
 */
import { Worker, type Processor } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { loadEnv } from '../config/env';
import { getLogger } from '../common/logger';
import { getDb, schema } from '../db/client';
import { PkmnPricesClient } from '../integrations/pkmnprices/client';
import { ConfigService } from '../server/services/config-service';
import { PricingService } from '../server/services/pricing';
import { PricingRouter } from '../server/services/pricing-router';
import { QUEUE_NAMES, bullConnection } from './queues';

interface BulkRefreshJob {
  storeId: string;
  language: string;
  skuIds: string[];
}

interface CatalogSyncJob {
  storeId: string;
  game?: string;
  page?: number;
  perPage?: number;
}

const env = loadEnv();
const db = getDb();
const log = getLogger();
const configs = new ConfigService(db);
const pricing = new PricingService(db);
const router = new PricingRouter(db, configs, pricing);

async function pkmnpricesFor(storeId: string): Promise<PkmnPricesClient> {
  const creds = await configs.getPkmnprices(storeId);
  return new PkmnPricesClient({ apiKey: creds.apiKey });
}

/**
 * Catalog sync refreshes name/set/number/rarity metadata for a single store's
 * known products within a game. Walks the local `products` table in pages.
 * Metadata comes from PkmnPrices, so only Pokémon products that carry a
 * PkmnPrices card id are synced — non-Pokémon games are manual-only (Option 3)
 * and are left untouched.
 */
const syncCatalog: Processor<CatalogSyncJob> = async (job) => {
  const { storeId } = job.data;
  const game = job.data.game;
  const page = job.data.page ?? 1;
  const perPage = job.data.perPage ?? 100;

  const offset = (page - 1) * perPage;
  const localProducts = await db
    .select({
      id: schema.products.id,
      game: schema.products.game,
      pkmnpricesId: schema.products.pkmnpricesProductId,
    })
    .from(schema.products)
    .where(
      game
        ? sql`${schema.products.storeId} = ${storeId} AND ${schema.products.game} = ${game}`
        : eq(schema.products.storeId, storeId),
    )
    .orderBy(schema.products.id)
    .limit(perPage)
    .offset(offset);

  // Only Pokémon products with a PkmnPrices id can be metadata-synced.
  const syncable = localProducts.filter((p) => p.game === 'pokemon' && p.pkmnpricesId != null);
  let refreshed = 0;
  if (syncable.length > 0) {
    const pk = await pkmnpricesFor(storeId);
    for (const p of syncable) {
      try {
        const card = await pk.getCard(p.pkmnpricesId!);
        await db
          .update(schema.products)
          .set({
            name: card.name,
            setName: card.setName,
            cardNumber: card.number,
            rarity: card.rarity,
            updatedAt: new Date(),
          })
          .where(eq(schema.products.id, p.id));
        refreshed += 1;
      } catch (err) {
        log.warn({ productId: p.id, err: (err as Error).message }, 'catalog refresh failed');
      }
    }
  }
  return { storeId, game: game ?? null, page, refreshed, hasMore: localProducts.length === perPage };
};

const retryWebhook: Processor<{ eventId: string; provider?: string }> = async (job) => {
  log.info({ eventId: job.data.eventId, provider: job.data.provider }, '[webhook.retry] picked up');
  return { ok: true };
};

/**
 * Batch price-refresh processor. Fans a small SKU list out through the
 * pricing router at bounded concurrency so we (a) don't blow past
 * PkmnPrices' 60 rpm rate limit and (b) keep BullMQ job overhead tiny
 * regardless of catalog size. One job per (storeId, language, batchIdx) per
 * day, id `bulk-{storeId}-{language}-{batchIdx}-{yyyy-mm-dd}` (idempotent).
 */
const bulkRefresh: Processor<BulkRefreshJob> = async (job) => {
  const { storeId, language, skuIds } = job.data;
  const started = Date.now();
  const limit = pLimit(5);

  const counts = { wrote: 0, skipped: 0, no_data: 0, no_id: 0, no_provider: 0, error: 0 };

  const results = await Promise.all(
    skuIds.map((skuId) =>
      limit(async () => {
        const r = await router.refreshSkuPrice(skuId);
        counts[r.action] += 1;
        return r;
      }),
    ),
  );

  log.info(
    { storeId, language, size: skuIds.length, durationMs: Date.now() - started, ...counts },
    'pricing.bulk-refresh completed',
  );
  return { ok: true, counts, size: skuIds.length, sampleErrors: results.filter((r) => r.err).slice(0, 5) };
};

function startWorker<T>(name: string, processor: Processor<T>): Worker<T> {
  const w = new Worker<T>(name, processor, {
    connection: bullConnection(),
    concurrency: env.WORKER_CONCURRENCY,
  });
  w.on('failed', (job, err) => {
    log.error({ jobId: job?.id ?? null, worker: name, err: err.message }, 'worker job failed');
  });
  return w;
}

startWorker(QUEUE_NAMES.bulkRefresh, bulkRefresh);
startWorker(QUEUE_NAMES.catalogSync, syncCatalog);
startWorker(QUEUE_NAMES.webhookRetry, retryWebhook);

log.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker up');
