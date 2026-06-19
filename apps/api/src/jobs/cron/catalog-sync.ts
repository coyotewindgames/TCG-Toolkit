/**
 * Nightly cron entrypoint. Enqueues both catalog-metadata refresh jobs and
 * price-refresh jobs so the worker can keep product info and current prices
 * in sync with TCGapi.dev for stores that have configured credentials.
 */
import { GAMES } from '@tcg/shared';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/client';
import { getQueues } from '../queues';

function dbTargetForLog(): string {
  try {
    const raw = process.env.DATABASE_URL;
    if (!raw) return '(DATABASE_URL missing)';
    const u = new URL(raw);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return '(DATABASE_URL parse error)';
  }
}

function isMissingConfigTable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  return cause?.code === '42P01';
}

async function main() {
  const db = getDb();
  const queues = getQueues();
  const today = new Date().toISOString().slice(0, 10);

  // eslint-disable-next-line no-console
  console.log(`[cron] database target: ${dbTargetForLog()}`);

  const storeRows = await db.select({ id: schema.stores.id }).from(schema.stores).limit(10);
  // eslint-disable-next-line no-console
  console.log(
    `[cron] visible stores (${storeRows.length} sampled): ${storeRows.length ? storeRows.map((s) => s.id).join(', ') : '(none)'}`,
  );

  let configuredStoreIds: string[] = [];
  try {
    const configured = await db.execute(sql<{ storeId: string }>`
      select distinct store_id::text as "storeId"
      from public.tcgapi_configs
      where coalesce(api_key_ciphertext, '') <> ''
    `);
    configuredStoreIds = configured.rows
      .map((r) => {
        const row = r as { storeId?: unknown };
        return typeof row.storeId === 'string' ? row.storeId : null;
      })
      .filter((id): id is string => id != null);
  } catch (err) {
    if (isMissingConfigTable(err)) {
      throw new Error(
        'Missing table "tcgapi_configs". Run the API migrations against the Render database before the nightly catalog cron can read saved TCGapi keys.',
        { cause: err },
      );
    }
    throw err;
  }

  let total = 0;
  let priceJobs = 0;

  // eslint-disable-next-line no-console
  console.log(
    `[cron] configured tcgapi store ids: ${configuredStoreIds.length ? configuredStoreIds.join(', ') : '(none)'}`,
  );

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

  for (const storeId of configuredStoreIds) {
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
    `[cron] enqueued ${total} catalog-sync jobs and ${priceJobs} price-refresh jobs across ${configuredStoreIds.length} stores`,
  );
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cron] failed', err);
  process.exit(1);
});
