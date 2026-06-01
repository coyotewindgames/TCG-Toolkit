/**
 * Standalone migration runner used by the Render pre-deploy step:
 *   tsx src/db/migrate.ts
 *
 * Uses Drizzle's pg migrator against the generated SQL in ./drizzle.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool } from './client';
import { getLogger } from '../common/logger';

async function main() {
  const db = getDb();
  await migrate(db, { migrationsFolder: './drizzle' });
  getLogger().info('drizzle migrations applied');
  await getPool().end();
}

main().catch((err) => {
  getLogger().fatal({ err }, 'migration failed');
  process.exit(1);
});
