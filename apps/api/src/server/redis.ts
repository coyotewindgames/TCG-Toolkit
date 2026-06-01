import Redis from 'ioredis';
import { loadEnv } from '../config/env';
import { getLogger } from '../common/logger';

let primary: Redis | null = null;

/**
 * Shared ioredis client. `maxRetriesPerRequest: null` is required by BullMQ;
 * the offline queue lets us survive brief Redis hiccups without dropping
 * scans or webhooks.
 */
export function getRedis(): Redis {
  if (!primary) {
    primary = new Redis(loadEnv().REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    primary.on('error', (err) => {
      getLogger().error({ err }, '[redis] error');
    });
  }
  return primary;
}

/** Duplicate connections for Socket.IO pub/sub adapter. */
export function duplicateRedis(): Redis {
  return getRedis().duplicate();
}

export async function closeRedis(): Promise<void> {
  if (!primary) return;
  await primary.quit();
  primary = null;
}
