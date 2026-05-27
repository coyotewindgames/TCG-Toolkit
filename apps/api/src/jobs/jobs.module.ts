import { Module, Global, Inject } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { REDIS } from '../common/redis.module';

export const QUEUE_NAMES = {
  priceRefresh: 'price-refresh',
  ebaySync: 'ebay-sync',
  tcgplayerCatalogSync: 'tcgplayer-catalog-sync',
  webhookRetry: 'webhook-retry',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const QUEUES = Symbol('QUEUES');

export interface Queues {
  priceRefresh: Queue;
  ebaySync: Queue;
  tcgplayerCatalogSync: Queue;
  webhookRetry: Queue;
}

@Global()
@Module({
  providers: [
    {
      provide: QUEUES,
      inject: [REDIS],
      useFactory: (redis: Redis): Queues => {
        const connection = redis as unknown as ConnectionOptions;
        const opts = {
          connection,
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential' as const, delay: 5_000 },
            removeOnComplete: { age: 24 * 3600, count: 1000 },
            removeOnFail: { age: 7 * 24 * 3600 },
          },
        };
        return {
          priceRefresh: new Queue(QUEUE_NAMES.priceRefresh, opts),
          ebaySync: new Queue(QUEUE_NAMES.ebaySync, opts),
          tcgplayerCatalogSync: new Queue(QUEUE_NAMES.tcgplayerCatalogSync, opts),
          webhookRetry: new Queue(QUEUE_NAMES.webhookRetry, opts),
        };
      },
    },
  ],
  exports: [QUEUES],
})
export class JobsModule {}

/** Helper that the worker entrypoint uses to create Worker instances. */
export function makeWorker<T>(
  name: QueueName,
  redis: Redis,
  processor: (job: { data: T }) => Promise<void>,
): Worker<T> {
  return new Worker<T>(name, async (job) => processor(job), {
    connection: redis as unknown as ConnectionOptions,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  });
}

export const InjectQueues = () => Inject(QUEUES);
