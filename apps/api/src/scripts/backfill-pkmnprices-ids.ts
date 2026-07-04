/**
 * One-shot: resolve `products.pkmnprices_product_id` for every product that
 * still has NULL. Matches by (name, set_name, card_number) using the
 * PkmnPrices catalog. Runs at a bounded concurrency so a Pro-tier key stays
 * well under the 60-rpm limit.
 *
 *   tsx --env-file=../../.env --env-file=.env src/scripts/backfill-pkmnprices-ids.ts
 *
 * Only Pokémon products are considered. Others keep their NULL id and the
 * pricing router falls back to tcgapi for them.
 *
 * STORE_ID env narrows the scan to one store when set.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { getDb, schema } from '../db/client';
import { ConfigService } from '../server/services/config-service';
import { PkmnPricesClient } from '../integrations/pkmnprices/client';

async function main(): Promise<void> {
  const db = getDb();
  const configs = new ConfigService(db);
  const storeId = process.env.STORE_ID?.trim();

  const whereClauses = [
    isNull(schema.products.pkmnpricesProductId),
    eq(schema.products.game, 'pokemon'),
  ];
  if (storeId) whereClauses.push(eq(schema.products.storeId, storeId));

  const rows = await db
    .select({
      id: schema.products.id,
      storeId: schema.products.storeId,
      name: schema.products.name,
      setName: schema.products.setName,
      cardNumber: schema.products.cardNumber,
    })
    .from(schema.products)
    .where(and(...whereClauses))
    .limit(5000);

  console.log(`[backfill-pkmnprices] scanning ${rows.length} products` + (storeId ? ` in store ${storeId}` : ''));

  // Per-store client cache — decrypt once.
  const clients = new Map<string, PkmnPricesClient>();
  async function clientFor(sid: string): Promise<PkmnPricesClient | null> {
    if (clients.has(sid)) return clients.get(sid)!;
    try {
      const creds = await configs.getPkmnprices(sid);
      const c = new PkmnPricesClient({ apiKey: creds.apiKey });
      clients.set(sid, c);
      return c;
    } catch {
      return null;
    }
  }

  const limit = pLimit(3); // 3 concurrent x ~1 req each = well under 60 rpm.
  let matched = 0;
  let ambiguous = 0;
  let noMatch = 0;
  let noConfig = 0;

  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        const client = await clientFor(row.storeId);
        if (!client) {
          noConfig += 1;
          return;
        }
        try {
          const page = await client.searchCards({
            name: row.name,
            number: row.cardNumber ?? undefined,
            per_page: 5,
          });
          // If we get exactly one result, commit it. If multiple, only commit
          // when set name matches (case-insensitive contains) — otherwise
          // flag as ambiguous and skip.
          let winner = page.results.length === 1 ? page.results[0] : null;
          if (!winner && page.results.length > 1 && row.setName) {
            const needle = row.setName.toLowerCase();
            winner = page.results.find((r) => r.setName?.toLowerCase().includes(needle)) ?? null;
          }
          if (!winner) {
            if (page.results.length > 1) ambiguous += 1;
            else noMatch += 1;
            return;
          }
          await db
            .update(schema.products)
            .set({ pkmnpricesProductId: winner.id, updatedAt: new Date() })
            .where(eq(schema.products.id, row.id));
          matched += 1;
        } catch (err) {
          console.warn(`[backfill-pkmnprices] error for "${row.name}"`, (err as Error).message);
        }
      }),
    ),
  );

  console.log(`[backfill-pkmnprices] matched=${matched} ambiguous=${ambiguous} noMatch=${noMatch} noConfig=${noConfig}`);
  // Silence the sql import (kept for symmetry with other backfill scripts).
  void sql;
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-pkmnprices] failed', err);
  process.exit(1);
});
