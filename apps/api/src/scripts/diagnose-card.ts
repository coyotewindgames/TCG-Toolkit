/**
 * diagnose-card.ts — one-shot investigator for "why isn't card X updating?".
 *
 * Given a card name (and optional store id), prints:
 *   - matching `products` rows (with tcgapi_product_id, game, set, language cues)
 *   - all SKUs per product with condition/printing/language
 *   - `current_prices` row for each SKU
 *   - most recent 5 `price_snapshots` per SKU
 *   - whether the store has TCGapi + saved query games configured
 *
 * Usage (PowerShell):
 *   npm run diagnose:card -w @tcg/api -- "Ash Greninja"
 *   $env:STORE_ID="uuid"; npm run diagnose:card -w @tcg/api -- "Ash Greninja"
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '../db/client';

async function main() {
  const nameArg = process.argv.slice(2).join(' ').trim();
  if (!nameArg) {
    console.error('usage: diagnose-card "<card name substring>"');
    process.exit(1);
  }

  const db = getDb();
  const scopedStoreId = process.env.STORE_ID?.trim() || null;

  // Configured stores + a snapshot of their tcgapi status.
  const stores = await db
    .select({ id: schema.stores.id, name: schema.stores.name })
    .from(schema.stores);
  console.log(`\n=== stores (${stores.length}) ===`);
  for (const s of stores) {
    if (scopedStoreId && s.id !== scopedStoreId) continue;
    const [cfg] = await db
      .select({
        baseUrl: schema.tcgapiConfigs.baseUrl,
        querySlugs: schema.tcgapiConfigs.queryGameSlugs,
        lastVerifiedAt: schema.tcgapiConfigs.lastVerifiedAt,
      })
      .from(schema.tcgapiConfigs)
      .where(eq(schema.tcgapiConfigs.storeId, s.id))
      .limit(1);
    console.log(
      `  ${s.id}  ${s.name}  tcgapi=${cfg ? 'configured' : 'MISSING'}  querySlugs=${
        cfg ? JSON.stringify(cfg.querySlugs ?? []) : '-'
      }  lastVerifiedAt=${cfg?.lastVerifiedAt?.toISOString() ?? '-'}`,
    );
  }

  const needle = `%${nameArg}%`;
  const productWhere = scopedStoreId
    ? and(eq(schema.products.storeId, scopedStoreId), ilike(schema.products.name, needle))
    : ilike(schema.products.name, needle);

  const products = await db
    .select({
      id: schema.products.id,
      storeId: schema.products.storeId,
      name: schema.products.name,
      game: schema.products.game,
      setName: schema.products.setName,
      cardNumber: schema.products.cardNumber,
      rarity: schema.products.rarity,
      tcgapiProductId: schema.products.tcgapiProductId,
      updatedAt: schema.products.updatedAt,
    })
    .from(schema.products)
    .where(productWhere)
    .orderBy(schema.products.storeId, schema.products.name)
    .limit(50);

  console.log(`\n=== products matching "${nameArg}" (${products.length}) ===`);
  if (products.length === 0) {
    console.log(
      '  (no matches) — either the SKU was never imported, or the name is spelled differently.',
    );
  }

  for (const p of products) {
    console.log(
      `\n  ${p.name}  [${p.game}]  set=${p.setName ?? '-'}  #${p.cardNumber ?? '-'}  rarity=${
        p.rarity ?? '-'
      }`,
    );
    console.log(
      `    productId=${p.id}  storeId=${p.storeId}  tcgapiProductId=${
        p.tcgapiProductId ?? 'MISSING — nightly job will skip this product'
      }`,
    );

    const skus = await db
      .select({
        id: schema.skus.id,
        condition: schema.skus.condition,
        printing: schema.skus.printing,
        language: schema.skus.language,
        barcode: schema.skus.barcode,
      })
      .from(schema.skus)
      .where(eq(schema.skus.productId, p.id));

    for (const s of skus) {
      const [cp] = await db
        .select({
          sell: schema.currentPrices.sellPriceCents,
          buy: schema.currentPrices.buyPriceCents,
          market: schema.currentPrices.marketPriceCents,
          median: schema.currentPrices.marketMedianCents,
          updatedAt: schema.currentPrices.updatedAt,
        })
        .from(schema.currentPrices)
        .where(eq(schema.currentPrices.skuId, s.id))
        .limit(1);

      console.log(
        `    sku ${s.id}  ${s.condition}/${s.printing}/${s.language}` +
          (cp
            ? `  sell=${cp.sell}  buy=${cp.buy}  market=${cp.market ?? '-'}  updated=${cp.updatedAt.toISOString()}`
            : '  (no current_prices row)'),
      );

      const snaps = await db
        .select({
          source: schema.priceSnapshots.source,
          price: schema.priceSnapshots.priceCents,
          at: schema.priceSnapshots.capturedAt,
        })
        .from(schema.priceSnapshots)
        .where(eq(schema.priceSnapshots.skuId, s.id))
        .orderBy(desc(schema.priceSnapshots.capturedAt))
        .limit(5);
      if (snaps.length === 0) {
        console.log('        no price_snapshots — the price refresh job has never written for this SKU');
      } else {
        for (const snap of snaps) {
          console.log(`        ${snap.at.toISOString()}  ${snap.source}=${snap.price}`);
        }
      }
    }
  }

  console.log('\n=== likely diagnosis ===');
  const missingIds = products.filter((p) => !p.tcgapiProductId);
  const jpProducts = products.filter(
    (p) =>
      /japanese/i.test(p.setName ?? '') || /jp[_-]/i.test(p.tcgapiProductId ?? ''),
  );
  if (products.length === 0) {
    console.log('  no matching products in DB — check inventory import');
  } else {
    if (missingIds.length > 0) {
      console.log(
        `  ${missingIds.length} product(s) are missing tcgapi_product_id — the nightly job cannot refresh them.`,
      );
    }
    if (jpProducts.length > 0) {
      console.log(
        `  ${jpProducts.length} product(s) look Japanese — tcgapi.dev has no JP prices; migrate to PkmnPrices Pro.`,
      );
    }
    if (missingIds.length === 0 && jpProducts.length === 0) {
      console.log(
        '  products look eligible for refresh — check worker logs for the SKU ids above around the last cron run.',
      );
    }
  }

  // Silence lint on unused helper we still want in scope for ad-hoc tweaks.
  void or;
  void sql;
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
