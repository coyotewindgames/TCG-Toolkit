import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let dbInstance: Database | null = null;

export function getPool(databaseUrl = process.env.DATABASE_URL): Pool {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      // Render's managed Postgres uses a Render-issued CA. In production we
      // enforce SSL with certificate validation; opt-out is only allowed when
      // explicitly requested for self-hosted/unmanaged deployments.
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined,
      max: Number(process.env.PG_POOL_MAX ?? 10),
    });
  }
  return pool;
}

export function getDb(databaseUrl = process.env.DATABASE_URL): Database {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(databaseUrl), { schema });
  }
  return dbInstance;
}

export { schema };
