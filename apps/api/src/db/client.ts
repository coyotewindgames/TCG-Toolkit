import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { getLogger } from '../common/logger';

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
  const raw = (process.env.EXPECTED_DATABASE_HOST ?? '').trim();
  if (!raw) return;
  // Accept either a bare hostname or a full URL in EXPECTED_DATABASE_HOST.
  const expected = databaseHost(raw) || raw.toLowerCase();
  const actual = databaseHost(databaseUrl).toLowerCase();
  if (!actual) return; // can't parse — skip the check
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `DATABASE_URL host mismatch: expected "${expected}", got "${actual}". Update DATABASE_URL or EXPECTED_DATABASE_HOST in Render.`,
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
      // Serverless Postgres (Neon) auto-suspends the compute after idle and
      // drops connections. Keep TCP sockets alive, retire pooled clients
      // before Neon does so we never hand a request a dead connection, and
      // cap how long we wait for a suspended compute to wake.
      keepAlive: true,
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 10_000),
    });
    // Without this listener, an error emitted on an idle client (e.g. Neon
    // terminating a suspended connection) is an unhandled 'error' event that
    // can crash the process. Absorb it and let the pool recycle the client.
    pool.on('error', (err) => {
      getLogger().warn({ err }, 'idle pg client error (connection will be recycled)');
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
