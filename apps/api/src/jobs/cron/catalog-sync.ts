/**
 * Nightly cron entrypoint. Enqueues a catalog walk per (store, game) so the
 * worker process picks them up. Only stores with a configured TCGapi.dev key
 * are scheduled.
 */
import { GAMES } from '@tcg/shared';
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
