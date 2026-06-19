import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let dbInstance: Database | null = null;

function databaseHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function assertExpectedDatabaseHost(databaseUrl: string): void {
  const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
  const expected = (process.env.EXPECTED_DATABASE_HOST ?? '').trim().toLowerCase();
  const actual = databaseHost(databaseUrl).toLowerCase();
  if (!actual) {
    throw new Error('DATABASE_URL is invalid; unable to parse database host');
  }
  if (!expected) {
    if (isProd) {
      throw new Error(
        `EXPECTED_DATABASE_HOST is required in production. DATABASE_URL currently points to "${actual}".`,
      );
    }
    return;
  }
  if (actual !== expected) {
    throw new Error(
      `DATABASE_URL host mismatch: expected "${expected}", got "${actual}". Update Render DATABASE_URL/EXPECTED_DATABASE_HOST to the same target.`,
    );
  }
}

export function getPool(databaseUrl = process.env.DATABASE_URL): Pool {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!pool) {
    assertExpectedDatabaseHost(databaseUrl);
    // Detect cloud-hosted Postgres (Neon, Supabase, RDS, Render, etc.) by
    // checking for a non-local hostname. When detected we enforce SSL so the
    // connection string's `?sslmode=require` is respected regardless of NODE_ENV.
    const isRemote = !/localhost|127\.0\.0\.1/.test(databaseUrl);
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: isRemote
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
