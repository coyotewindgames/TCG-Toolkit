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
import { TcgapiClient } from '../integrations/tcgapi/client';
import { ConfigService } from '../server/services/config-service';
import { PricingService } from '../server/services/pricing';
import { PricingRouter } from '../server/services/pricing-router';
import { QUEUE_NAMES, bullConnection } from './queues';

interface PriceRefreshJob {
  storeId: string;
  skuId: string;
  tcgapiCardId: string;
  printing?: string;
}

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

function tcgapiPrintingToEnum(label: string | null | undefined): string {
  const normalized = (label ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return 'Normal';
  if (normalized.includes('reverseholo') || normalized === 'reverse' || normalized === 'rh') {
    return 'Reverse';
  }
  if (normalized.includes('1stedition') || normalized.includes('firstedition')) {
    return 'FirstEdition';
  }
  if (normalized.includes('holo')) return 'Holo';
  if (normalized.includes('foil') && !normalized.includes('non')) return 'Foil';
  if (normalized.includes('nonfoil') || normalized.includes('normal') || normalized === 'regular') {
    return 'Normal';
  }
  return 'Normal';
}

const env = loadEnv();
const db = getDb();
const log = getLogger();
const configs = new ConfigService(db);
const pricing = new PricingService(db);
const router = new PricingRouter(db, configs, pricing);

async function tcgapiFor(storeId: string): Promise<TcgapiClient> {
  const creds = await configs.getTcgapi(storeId);
  return new TcgapiClient({ baseUrl: creds.baseUrl, apiKey: creds.apiKey });
}

const refreshPrice: Processor<PriceRefreshJob> = async (job) => {
  const { storeId, skuId, tcgapiCardId, printing } = job.data;
  const tcgapi = await tcgapiFor(storeId);
  const rows = await tcgapi.getCardPrices(tcgapiCardId);
  const row = printing ? rows.find((r) => tcgapiPrintingToEnum(r.printing) === printing) : rows[0];
  if (!row) {
    log.warn(
      {
        storeId,
        skuId,
        tcgapiCardId,
        printing,
        availablePrintings: rows.map((r) => r.printing),
      },
      'price refresh skipped: no matching price row',
    );
    return { skipped: true };
  }

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
    .select({
      id: schema.products.id,
      tcgapiId: schema.products.tcgapiProductId,
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

startWorker(QUEUE_NAMES.priceRefresh, refreshPrice);
startWorker(QUEUE_NAMES.bulkRefresh, bulkRefresh);
startWorker(QUEUE_NAMES.catalogSync, syncCatalog);
startWorker(QUEUE_NAMES.webhookRetry, retryWebhook);

log.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker up');
