import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => {
        const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
        // `maxRetriesPerRequest: null` is required for BullMQ; offline queue
        // smooths over brief Redis hiccups so we don't drop scans.
        return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
