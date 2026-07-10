/**
 * One-shot: populate `products.artist` for every Pokémon product that has a
 * `pkmnprices_product_id` but no artist yet. Resolves each unique pkmnprices
 * card id via `cards.get(id)` — dedup happens across variants (different
 * conditions/printings map to the same pkmnprices id), and the concurrency
 * limit keeps us under the 60 rpm cap of the Pro tier.
 *
 *   tsx --env-file=../../.env --env-file=.env src/scripts/backfill-artists.ts
 *
 * STORE_ID env narrows the scan to one store when set.
 *
 * Products without a `pkmnprices_product_id` are skipped; run the id backfill
 * (`backfill-pkmnprices-ids.ts`) first to widen the pool.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { getDb, schema } from '../db/client';
import { ConfigService } from '../server/services/config-service';
import { PkmnPricesClient } from '../integrations/pkmnprices/client';

async function main(): Promise<void> {
  const db = getDb();
  const configs = new ConfigService(db);
  const storeIdFilter = process.env.STORE_ID?.trim();

  const whereClauses = [
    isNotNull(schema.products.pkmnpricesProductId),
    isNull(schema.products.artist),
    eq(schema.products.game, 'pokemon'),
  ];
  if (storeIdFilter) whereClauses.push(eq(schema.products.storeId, storeIdFilter));

  const rows = await db
    .select({
      id: schema.products.id,
      storeId: schema.products.storeId,
      pkmnpricesProductId: schema.products.pkmnpricesProductId,
    })
    .from(schema.products)
    .where(and(...whereClauses))
    .limit(50_000);

  console.log(
    `[backfill-artists] scanning ${rows.length} products` +
      (storeIdFilter ? ` in store ${storeIdFilter}` : ''),
  );

  // Dedupe: many local products (different conditions/printings) can point at
  // the same pkmnprices id. One API call hydrates all of them.
  type Bucket = { storeId: string; pkmnpricesId: number; productIds: string[] };
  const byKey = new Map<string, Bucket>();
  for (const row of rows) {
    if (row.pkmnpricesProductId == null) continue;
    const key = `${row.storeId}|${row.pkmnpricesProductId}`;
    let b = byKey.get(key);
    if (!b) {
      b = {
        storeId: row.storeId,
        pkmnpricesId: row.pkmnpricesProductId,
        productIds: [],
      };
      byKey.set(key, b);
    }
    b.productIds.push(row.id);
  }
  console.log(`[backfill-artists] ${byKey.size} unique pkmnprices ids to fetch`);

  const clients = new Map<string, PkmnPricesClient | null>();
  async function clientFor(sid: string): Promise<PkmnPricesClient | null> {
    if (clients.has(sid)) return clients.get(sid) ?? null;
    try {
      const creds = await configs.getPkmnprices(sid);
      const c = new PkmnPricesClient({ apiKey: creds.apiKey });
      clients.set(sid, c);
      return c;
    } catch {
      clients.set(sid, null);
      return null;
    }
  }

  // 2 concurrent × ~1 rpc = 40-60 rpm effective. Stays under Pro-tier 60 rpm.
  const limit = pLimit(2);
  let updated = 0;
  let missing = 0;
  let noConfig = 0;
  let errored = 0;

  await Promise.all(
    [...byKey.values()].map((bucket) =>
      limit(async () => {
        const client = await clientFor(bucket.storeId);
        if (!client) {
          noConfig += bucket.productIds.length;
          return;
        }
        try {
          const card = await client.getCard(bucket.pkmnpricesId);
          const artist = card.artist?.trim();
          if (artist) {
            await db
              .update(schema.products)
              .set({ artist, updatedAt: new Date() })
              .where(inArray(schema.products.id, bucket.productIds));
            updated += bucket.productIds.length;
          } else {
            missing += bucket.productIds.length;
          }
        } catch (err) {
          errored += 1;
          console.warn(
            `[backfill-artists] cards.get(${bucket.pkmnpricesId}) failed:`,
            (err as Error).message,
          );
        }
      }),
    ),
  );

  console.log(
    `[backfill-artists] updated=${updated} missing=${missing} noConfig=${noConfig} errored=${errored}`,
  );
  void sql;
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-artists] failed', err);
  process.exit(1);
});
