/**
 * Backfill: ensure every SKU row has its `barcode` column equal to its `id`.
 * Safe to run repeatedly — only updates rows whose barcode is NULL or not a UUID.
 */
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';

async function main(): Promise<void> {
  const db = getDb();
  const result = await db.execute(sql`
    UPDATE skus
       SET barcode = id::text
     WHERE barcode IS NULL
        OR barcode !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  `);
  // pg `Result` exposes rowCount (camelCase) on the underlying driver result.
  const updated = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  // eslint-disable-next-line no-console
  console.log(`backfill complete: ${updated} sku rows updated`);
  await getPool().end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
