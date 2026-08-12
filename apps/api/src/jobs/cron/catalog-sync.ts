/**
 * Nightly cron entrypoint. Enqueues both catalog-metadata refresh jobs and
 * price-refresh jobs so the worker can keep Pokémon product info and current
 * prices in sync with PkmnPrices for stores that have configured credentials.
 * Graded SKUs are handled by the separate weekly graded-sync cron.
 */
import { eq, inArray, sql } from 'drizzle-orm';
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
      from public.pkmnprices_configs
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
        'Missing table "pkmnprices_configs". Run the API migrations against the Render database before the nightly catalog cron can read saved PkmnPrices keys.',
        { cause: err },
      );
    }
    throw err;
  }

  let total = 0;
  let priceJobs = 0;

  // eslint-disable-next-line no-console
  console.log(
    `[cron] configured pkmnprices store ids: ${configuredStoreIds.length ? configuredStoreIds.join(', ') : '(none)'}`,
  );

  if (configuredStoreIds.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      '[cron] no stores found in pkmnprices_configs; save/verify PkmnPrices credentials in Settings for at least one store',
    );
  }

  if (configuredStoreIds.length > 0) {
    const skuRows = await db
      .select({
        storeId: schema.products.storeId,
        skuId: schema.skus.id,
        language: schema.skus.language,
        gradingCompany: schema.skus.gradingCompany,
        tcgapiCardId: schema.products.tcgapiProductId,
        pkmnpricesCardId: schema.products.pkmnpricesProductId,
      })
      .from(schema.skus)
      .innerJoin(schema.products, eq(schema.products.id, schema.skus.productId))
      .where(inArray(schema.products.storeId, configuredStoreIds));

    // Group SKUs by (storeId, language). Only enqueue SKUs that have at
    // least one upstream card id — those are the ones a provider can price.
    const groups = new Map<string, { storeId: string; language: string; skuIds: string[] }>();
    for (const row of skuRows) {
      // Graded SKUs price from eBay sold comps (expensive) and refresh on the
      // separate WEEKLY graded-sync cron, so skip them here.
      if (row.gradingCompany) continue;
      const hasId = !!row.pkmnpricesCardId || !!row.tcgapiCardId;
      if (!hasId) continue;
      const key = `${row.storeId}|${row.language}`;
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = { storeId: row.storeId, language: row.language, skuIds: [] };
        groups.set(key, bucket);
      }
      bucket.skuIds.push(row.skuId);
    }

    // Chunk each bucket into batches of 50 so a single BullMQ job stays small
    // and a failure only re-runs 50 SKUs.
    const BATCH_SIZE = 50;
    for (const bucket of groups.values()) {
      for (let i = 0; i < bucket.skuIds.length; i += BATCH_SIZE) {
        const batchIdx = i / BATCH_SIZE;
        const skuIds = bucket.skuIds.slice(i, i + BATCH_SIZE);
        await queues.bulkRefresh.add(
          'refresh',
          { storeId: bucket.storeId, language: bucket.language, skuIds },
          {
            jobId: `bulk-${bucket.storeId}-${bucket.language}-${batchIdx}-${today}`,
          },
        );
        priceJobs += 1;
      }
    }
  }

  // Catalog metadata is only synced for Pokémon (from PkmnPrices); non-Pokémon
  // games are manual-only (Option 3), so we no longer loop the full GAMES enum.
  for (const storeId of configuredStoreIds) {
    await queues.catalogSync.add(
      'sync',
      { storeId, game: 'pokemon', page: 1 },
      { jobId: `catalog-${storeId}-pokemon-${today}` },
    );
    total += 1;
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
