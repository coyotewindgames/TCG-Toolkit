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
      // Render's managed Postgres requires SSL in production.
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
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
