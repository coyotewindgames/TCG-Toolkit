import { Module, Global } from '@nestjs/common';
import { getDb } from './client';

export const DRIZZLE = Symbol('DRIZZLE');

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => getDb(),
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
