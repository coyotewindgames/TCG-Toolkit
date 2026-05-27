/**
 * BullMQ worker. Consumes background jobs that should not block the request
 * path: price refresh from TCGapi.dev, catalog sync, image mirroring to R2,
 * and webhook retry.
 *
 * Each queue is registered with its own concurrency. The R2 mirror is a
 * stubbed handler until storage credentials are provisioned; it logs the
 * intended upload so the dependent jobs (and queue table) stay live.
 */
import { Worker, type Processor } from 'bullmq';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../config/env';
import { getDb, schema } from '../db/client';
import { TcgapiClient } from '../integrations/tcgapi/client';
import { PricingService } from '../server/services/pricing';
import { QUEUE_NAMES, bullConnection } from './queues';

interface PriceRefreshJob {
  skuId: string;
  tcgapiProductId: string;
}

interface CatalogSyncJob {
  game?: string;
  cursor?: string;
}

interface ImageMirrorJob {
  productId: string;
  sourceUrl: string;
}

const env = loadEnv();
const db = getDb();
const tcgapi = new TcgapiClient(env);
const pricing = new PricingService(db);

const refreshPrice: Processor<PriceRefreshJob> = async (job) => {
  const { skuId, tcgapiProductId } = job.data;
  const { prices } = await tcgapi.getPricing([tcgapiProductId]);
  const row = prices[0];
  if (!row) return { skipped: true };

  const writes: Array<Promise<unknown>> = [];
  if (typeof row.marketCents === 'number') {
    writes.push(
      pricing.recordSnapshot({ skuId, source: 'tcgapi_market', priceCents: row.marketCents }),
    );
  }
  if (typeof row.midCents === 'number') {
    writes.push(
      pricing.recordSnapshot({ skuId, source: 'tcgapi_mid', priceCents: row.midCents }),
    );
  }
  if (typeof row.lowCents === 'number') {
    writes.push(
      pricing.recordSnapshot({ skuId, source: 'tcgapi_low', priceCents: row.lowCents }),
    );
  }
  if (typeof row.highCents === 'number') {
    writes.push(
      pricing.recordSnapshot({ skuId, source: 'tcgapi_high', priceCents: row.highCents }),
    );
  }
  await Promise.all(writes);
  await pricing.recomputeCurrent(skuId);
  return { ok: true };
};

const syncCatalog: Processor<CatalogSyncJob> = async (job) => {
  // Walk TCGapi.dev catalog for products we've already seeded; refresh metadata.
  // The full crawl is paginated via `cursor`. For MVP we just refresh names.
  const { game, cursor } = job.data;
  const page = await tcgapi.searchProducts('', { game, cursor, limit: 100 });
  for (const p of page.results) {
    await db
      .update(schema.products)
      .set({
        name: p.name,
        setName: p.setName ?? null,
        cardNumber: p.cardNumber ?? null,
        rarity: p.rarity ?? null,
        imageSourceUrl: p.imageUrl ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.products.tcgapiProductId, p.id));
  }
  return { nextCursor: page.nextCursor ?? null, count: page.results.length };
};

const mirrorImage: Processor<ImageMirrorJob> = async (job) => {
  // TODO: implement R2 upload once R2_* env vars are provisioned.
  // eslint-disable-next-line no-console
  console.log(
    `[image.mirror] (stub) would mirror ${job.data.sourceUrl} for product ${job.data.productId}`,
  );
  return { skipped: true };
};

const retryWebhook: Processor<{ eventId: string }> = async (job) => {
  // Currently a no-op placeholder. The full retry policy is left to BullMQ's
  // built-in retry/backoff configuration on the job that fails inline.
  // eslint-disable-next-line no-console
  console.log(`[webhook.retry] event ${job.data.eventId}`);
  return { ok: true };
};

function startWorker<T>(name: string, processor: Processor<T>): Worker<T> {
  const w = new Worker<T>(name, processor, {
    connection: bullConnection(),
    concurrency: env.WORKER_CONCURRENCY,
  });
  w.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker:${name}] job ${job?.id ?? '?'} failed`, err.message);
  });
  return w;
}

startWorker(QUEUE_NAMES.priceRefresh, refreshPrice);
startWorker(QUEUE_NAMES.catalogSync, syncCatalog);
startWorker(QUEUE_NAMES.imageMirror, mirrorImage);
startWorker(QUEUE_NAMES.webhookRetry, retryWebhook);

// eslint-disable-next-line no-console
console.log('[worker] up; concurrency=' + env.WORKER_CONCURRENCY);
