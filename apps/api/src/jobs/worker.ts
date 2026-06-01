/**
 * BullMQ worker. Consumes background jobs that should not block the request
 * path: price refresh from tcgapi.dev, catalog metadata refresh, and webhook
 * retry placeholder.
 */
import { Worker, type Processor } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { loadEnv } from '../config/env';
import { getLogger } from '../common/logger';
import { getDb, schema } from '../db/client';
import { TcgapiClient } from '../integrations/tcgapi/client';
import { PricingService } from '../server/services/pricing';
import { QUEUE_NAMES, bullConnection } from './queues';

interface PriceRefreshJob {
  skuId: string;
  tcgapiCardId: string;
  printing?: string;
}

interface CatalogSyncJob {
  game?: string;
  page?: number;
  perPage?: number;
}

const env = loadEnv();
const db = getDb();
const log = getLogger();
const tcgapi = new TcgapiClient(env);
const pricing = new PricingService(db);

const refreshPrice: Processor<PriceRefreshJob> = async (job) => {
  const { skuId, tcgapiCardId, printing } = job.data;
  const rows = await tcgapi.getCardPrices(tcgapiCardId, { printing });
  // If a printing was requested, find the matching row; otherwise take the
  // first (single-printing card).
  const row = printing ? rows.find((r) => r.printing === printing) ?? rows[0] : rows[0];
  if (!row) return { skipped: true };

  const writes: Array<Promise<unknown>> = [];
  if (row.marketCents != null) {
    writes.push(pricing.recordSnapshot({ skuId, source: 'tcgapi_market', priceCents: row.marketCents }));
  }
  if (row.lowCents != null) {
    writes.push(pricing.recordSnapshot({ skuId, source: 'tcgapi_low', priceCents: row.lowCents }));
  }
  if (row.medianCents != null) {
    writes.push(pricing.recordSnapshot({ skuId, source: 'tcgapi_median', priceCents: row.medianCents }));
  }
  if (row.buylistCents != null) {
    writes.push(pricing.recordSnapshot({ skuId, source: 'tcgapi_buylist', priceCents: row.buylistCents }));
  }
  await Promise.all(writes);
  await pricing.recomputeCurrent(skuId);
  return { ok: true };
};

/**
 * Catalog sync refreshes name/set/image metadata for locally-known products
 * within a game. Walks our own `products` table in pages (not the upstream
 * catalog) so it works on the Starter tcgapi.dev tier without bulk access.
 */
const syncCatalog: Processor<CatalogSyncJob> = async (job) => {
  const game = job.data.game;
  const page = job.data.page ?? 1;
  const perPage = job.data.perPage ?? 100;

  const offset = (page - 1) * perPage;
  const localProducts = await db
    .select({ id: schema.products.id, tcgapiId: schema.products.tcgapiProductId })
    .from(schema.products)
    .where(game ? eq(schema.products.game, game as never) : sql`true`)
    .orderBy(schema.products.id)
    .limit(perPage)
    .offset(offset);

  let refreshed = 0;
  for (const p of localProducts) {
    if (!p.tcgapiId) continue;
    try {
      const card = await tcgapi.getCard(p.tcgapiId);
      await db
        .update(schema.products)
        .set({
          name: card.name,
          setName: card.setName,
          cardNumber: card.number,
          rarity: card.rarity,
          imageSourceUrl: card.imageUrl,
          updatedAt: new Date(),
        })
        .where(eq(schema.products.id, p.id));
      refreshed += 1;
    } catch (err) {
      log.warn({ productId: p.id, err: (err as Error).message }, 'catalog refresh failed');
    }
  }
  return { game: game ?? null, page, refreshed, hasMore: localProducts.length === perPage };
};

const retryWebhook: Processor<{ eventId: string; provider?: string }> = async (job) => {
  log.info({ eventId: job.data.eventId, provider: job.data.provider }, '[webhook.retry] picked up');
  return { ok: true };
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

startWorker(QUEUE_NAMES.priceRefresh, refreshPrice);
startWorker(QUEUE_NAMES.catalogSync, syncCatalog);
startWorker(QUEUE_NAMES.webhookRetry, retryWebhook);

log.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker up');
