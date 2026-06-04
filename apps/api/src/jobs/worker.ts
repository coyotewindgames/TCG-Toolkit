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
import { loadEnv } from '../config/env';
import { getLogger } from '../common/logger';
import { getDb, schema } from '../db/client';
import { TcgapiClient } from '../integrations/tcgapi/client';
import { ConfigService } from '../server/services/config-service';
import { PricingService } from '../server/services/pricing';
import { QUEUE_NAMES, bullConnection } from './queues';

interface PriceRefreshJob {
  storeId: string;
  skuId: string;
  tcgapiCardId: string;
  printing?: string;
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

async function tcgapiFor(storeId: string): Promise<TcgapiClient> {
  const creds = await configs.getTcgapi(storeId);
  return new TcgapiClient({ baseUrl: creds.baseUrl, apiKey: creds.apiKey });
}

const refreshPrice: Processor<PriceRefreshJob> = async (job) => {
  const { storeId, skuId, tcgapiCardId, printing } = job.data;
  const tcgapi = await tcgapiFor(storeId);
  const rows = await tcgapi.getCardPrices(tcgapiCardId, { printing });
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
 * Catalog sync refreshes name/set/image metadata for a single store's known
 * products within a game. Walks the local `products` table in pages — the
 * Starter tcgapi.dev tier does not include bulk endpoints.
 */
const syncCatalog: Processor<CatalogSyncJob> = async (job) => {
  const { storeId } = job.data;
  const game = job.data.game;
  const page = job.data.page ?? 1;
  const perPage = job.data.perPage ?? 100;

  const tcgapi = await tcgapiFor(storeId);

  const offset = (page - 1) * perPage;
  const localProducts = await db
    .select({ id: schema.products.id, tcgapiId: schema.products.tcgapiProductId })
    .from(schema.products)
    .where(
      game
        ? sql`${schema.products.storeId} = ${storeId} AND ${schema.products.game} = ${game}`
        : eq(schema.products.storeId, storeId),
    )
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
  return { storeId, game: game ?? null, page, refreshed, hasMore: localProducts.length === perPage };
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
