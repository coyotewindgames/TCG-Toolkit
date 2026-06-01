/**
 * Nightly cron entrypoint. Enqueues a catalog walk per supported game so the
 * worker process picks them up. Designed to be invoked from Render Cron or
 * any scheduler that runs `node dist/jobs/cron/catalog-sync.js`.
 */
import { GAMES } from '@tcg/shared';
import { getQueues } from '../queues';

async function main() {
  const queues = getQueues();
  for (const game of GAMES) {
    await queues.catalogSync.add(
      'sync',
      { game, page: 1 },
      { jobId: `catalog:${game}:${new Date().toISOString().slice(0, 10)}` },
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[cron] enqueued catalog sync for ${GAMES.length} games`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cron] failed', err);
  process.exit(1);
});
