/**
 * Standalone worker entrypoint. Render runs this as a separate service with
 * no public port. It consumes BullMQ queues:
 *   - price-refresh: pull latest TCGplayer pricing for in-stock SKUs
 *   - ebay-sync: refresh eBay 30/90-day medians per SKU
 *   - tcgplayer-catalog-sync: nightly catalog ingest
 *   - webhook-retry: re-process failed inbound webhooks
 */
import 'reflect-metadata';
import Redis from 'ioredis';
import { Worker } from 'bullmq';
import { QUEUE_NAMES } from './jobs/jobs.module';
import { getDb, getPool } from './db/client';
import { schema } from './db/client';
import { eq } from 'drizzle-orm';
import { TcgplayerClient } from './integrations/tcgplayer/tcgplayer.client';
import { EbayClient } from './integrations/ebay/ebay.client';

async function main() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const db = getDb();
  const tcg = new TcgplayerClient(redis);
  const ebay = new EbayClient(redis);

  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
  const log = (msg: string, extra?: unknown) => {
    // eslint-disable-next-line no-console
    console.log(`[worker] ${msg}`, extra ?? '');
  };

  new Worker(
    QUEUE_NAMES.priceRefresh,
    async (job) => {
      const { productIds } = job.data as { productIds: number[] };
      const data = await tcg.getPricing(productIds);
      log('priceRefresh', { count: (data.results ?? []).length });
      // TODO: map results → priceSnapshots + currentPrices via PricingService
    },
    { connection: redis as unknown as import("bullmq").ConnectionOptions, concurrency },
  );

  new Worker(
    QUEUE_NAMES.ebaySync,
    async (job) => {
      const { skuId, query } = job.data as { skuId: string; query: string };
      const items = await ebay.searchSold(query, 100);
      const medianCents = EbayClient.medianCents(items);
      if (medianCents != null) {
        await db.insert(schema.priceSnapshots).values({
          skuId,
          source: 'ebay_30d_median',
          priceCents: medianCents,
          sampleSize: items.length,
        });
      }
    },
    { connection: redis as unknown as import("bullmq").ConnectionOptions, concurrency },
  );

  new Worker(
    QUEUE_NAMES.tcgplayerCatalogSync,
    async () => {
      const cats = await tcg.getCategories();
      log('tcgplayerCatalogSync', { categories: (cats.results ?? []).length });
      // TODO: walk groups → products → upsert into `products` + `skus`
    },
    { connection: redis as unknown as import("bullmq").ConnectionOptions, concurrency: 1 },
  );

  new Worker(
    QUEUE_NAMES.webhookRetry,
    async (job) => {
      const { eventId } = job.data as { eventId: string };
      const [evt] = await db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.id, eventId));
      if (!evt || evt.processedAt) return;
      // Re-enqueue logic specific to provider goes here.
      log('webhookRetry', { eventId });
    },
    { connection: redis as unknown as import("bullmq").ConnectionOptions, concurrency: 2 },
  );

  log('worker started');

  const shutdown = async (signal: string) => {
    log(`received ${signal}, shutting down`);
    await redis.quit();
    await getPool().end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('worker fatal', err);
  process.exit(1);
});
