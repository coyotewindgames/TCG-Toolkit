/**
 * Nightly cron entrypoint. Enqueues both catalog-metadata refresh jobs and
 * price-refresh jobs so the worker can keep product info and current prices
 * in sync with TCGapi.dev for stores that have configured credentials.
 */
import { GAMES } from '@tcg/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../../db/client';
import { getQueues } from '../queues';

function isMissingTcgapiConfigsTable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  return cause?.code === '42P01';
}

async function main() {
  const db = getDb();
  const queues = getQueues();
  const today = new Date().toISOString().slice(0, 10);

  let configured: Array<{ storeId: string }>;
  try {
    configured = await db
      .select({ storeId: schema.tcgapiConfigs.storeId })
      .from(schema.tcgapiConfigs);
  } catch (err) {
    if (isMissingTcgapiConfigsTable(err)) {
      throw new Error(
        'Missing table "tcgapi_configs". Run the API migrations against the Render database before the nightly catalog cron can read saved TCGapi keys.',
        { cause: err },
      );
    }
    throw err;
  }

  let total = 0;
  let priceJobs = 0;
  const configuredStoreIds = configured.map((row) => row.storeId);

  if (configuredStoreIds.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      '[cron] no stores found in tcgapi_configs; save/verify TCGapi credentials in Settings for at least one store',
    );
  }

  if (configuredStoreIds.length > 0) {
    const skuRows = await db
      .select({
        storeId: schema.products.storeId,
        skuId: schema.skus.id,
        tcgapiCardId: schema.products.tcgapiProductId,
        printing: schema.skus.printing,
      })
      .from(schema.skus)
      .innerJoin(schema.products, eq(schema.products.id, schema.skus.productId))
      .where(
        and(
          inArray(schema.products.storeId, configuredStoreIds),
          isNotNull(schema.products.tcgapiProductId),
        ),
      );

    for (const row of skuRows) {
      await queues.priceRefresh.add(
        'refresh',
        {
          storeId: row.storeId,
          skuId: row.skuId,
          tcgapiCardId: row.tcgapiCardId,
          printing: row.printing,
        },
        { jobId: `price:${row.storeId}:${row.skuId}:${today}` },
      );
      priceJobs += 1;
    }
  }

  for (const { storeId } of configured) {
    for (const game of GAMES) {
      await queues.catalogSync.add(
        'sync',
        { storeId, game, page: 1 },
        { jobId: `catalog:${storeId}:${game}:${today}` },
      );
      total += 1;
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[cron] enqueued ${total} catalog-sync jobs and ${priceJobs} price-refresh jobs across ${configured.length} stores`,
  );
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cron] failed', err);
  process.exit(1);
});
