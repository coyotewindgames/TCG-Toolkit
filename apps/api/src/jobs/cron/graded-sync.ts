/**
 * Weekly cron entrypoint for graded (slabbed) SKUs. Graded pricing pulls live
 * eBay sold comps from PkmnPrices (1 credit per listings page, up to a few
 * credits per SKU) which is far pricier than the ungraded market lookup, so
 * graded SKUs refresh on a slower WEEKLY cadence instead of nightly. The
 * nightly `catalog-sync` cron deliberately skips graded SKUs so they are only
 * priced here.
 *
 * Graded SKUs are enqueued through the same `bulkRefresh` queue the nightly
 * cron uses; the pricing router already routes SKUs with a grading company to
 * the graded-eBay provider, so no separate worker is required.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../../db/client';
import { getQueues } from '../queues';

/** ISO-week stamp (e.g. `2026-W33`) so a re-run within the same week is idempotent. */
function isoWeekStamp(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function main() {
  const db = getDb();
  const queues = getQueues();
  const stamp = isoWeekStamp();

  // Only graded SKUs whose product carries a PkmnPrices card id can be priced
  // from eBay sold comps.
  const skuRows = await db
    .select({
      storeId: schema.products.storeId,
      skuId: schema.skus.id,
      language: schema.skus.language,
    })
    .from(schema.skus)
    .innerJoin(schema.products, eq(schema.products.id, schema.skus.productId))
    .where(
      and(
        isNotNull(schema.skus.gradingCompany),
        isNotNull(schema.products.pkmnpricesProductId),
      ),
    );

  // Group by (storeId, language) mirroring the nightly cron so the worker can
  // reuse one PkmnPrices client per language batch.
  const groups = new Map<string, { storeId: string; language: string; skuIds: string[] }>();
  for (const row of skuRows) {
    const key = `${row.storeId}|${row.language}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = { storeId: row.storeId, language: row.language, skuIds: [] };
      groups.set(key, bucket);
    }
    bucket.skuIds.push(row.skuId);
  }

  // Smaller batches than the nightly cron (graded lookups cost more credits and
  // take longer per SKU), so a failure re-runs fewer items.
  const BATCH_SIZE = 25;
  let priceJobs = 0;
  for (const bucket of groups.values()) {
    for (let i = 0; i < bucket.skuIds.length; i += BATCH_SIZE) {
      const batchIdx = i / BATCH_SIZE;
      const skuIds = bucket.skuIds.slice(i, i + BATCH_SIZE);
      await queues.bulkRefresh.add(
        'refresh',
        { storeId: bucket.storeId, language: bucket.language, skuIds },
        { jobId: `graded-${bucket.storeId}-${bucket.language}-${batchIdx}-${stamp}` },
      );
      priceJobs += 1;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[cron:graded] enqueued ${priceJobs} graded price-refresh jobs across ${groups.size} store/language buckets (${stamp})`,
  );
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cron:graded] failed', err);
  process.exit(1);
});
