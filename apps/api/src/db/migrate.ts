/**
 * Standalone migration runner used by the Render pre-deploy step:
 *   tsx src/db/migrate.ts
 *
 * Uses Drizzle's pg migrator against the generated SQL in ./drizzle.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool } from './client';

async function main() {
  const db = getDb();
  await migrate(db, { migrationsFolder: './drizzle' });
  // eslint-disable-next-line no-console
  console.log('drizzle migrations applied');
  await getPool().end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('migration failed', err);
  process.exit(1);
});
