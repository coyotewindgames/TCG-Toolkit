/**
 * Nightly cron entrypoint. Enqueues a catalog walk per (store, game) so the
 * worker process picks them up. Only stores with a configured TCGapi.dev key
 * are scheduled.
 */
import { GAMES } from '@tcg/shared';
import { getDb, schema } from '../../db/client';
import { getQueues } from '../queues';

async function main() {
  const db = getDb();
  const queues = getQueues();
  const today = new Date().toISOString().slice(0, 10);

  const configured = await db
    .select({ storeId: schema.tcgapiConfigs.storeId })
    .from(schema.tcgapiConfigs);

  let total = 0;
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
  console.log(`[cron] enqueued ${total} catalog-sync jobs across ${configured.length} stores`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cron] failed', err);
  process.exit(1);
});
