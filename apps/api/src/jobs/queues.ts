import { Queue, type ConnectionOptions } from 'bullmq';
import { loadEnv } from '../config/env';

/** Job queue names. Add new ones here so workers register them in one place. */
export const QUEUE_NAMES = {
  priceRefresh: 'price.refresh',
  catalogSync: 'catalog.sync',
  webhookRetry: 'webhook.retry',
} as const;

/**
 * BullMQ ships its own pinned ioredis, so passing our shared Redis instance
 * trips a TS variance check. Hand BullMQ a connection-options object instead;
 * it will manage its own client internally.
 */
export function bullConnection(): ConnectionOptions {
  const url = new URL(loadEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

let queues: Record<keyof typeof QUEUE_NAMES, Queue> | null = null;

export function getQueues(): Record<keyof typeof QUEUE_NAMES, Queue> {
  if (queues) return queues;
  const connection = bullConnection();
  queues = {
    priceRefresh: new Queue(QUEUE_NAMES.priceRefresh, { connection }),
    catalogSync: new Queue(QUEUE_NAMES.catalogSync, { connection }),
    webhookRetry: new Queue(QUEUE_NAMES.webhookRetry, { connection }),
  };
  return queues;
}
