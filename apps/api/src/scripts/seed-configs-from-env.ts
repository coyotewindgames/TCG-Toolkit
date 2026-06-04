/**
 * One-shot bootstrap helper: read legacy env-var credentials and load them
 * into the encrypted `tcgapi_configs` / `pos_configs` tables for a given
 * store. Idempotent — skips stores that already have a row.
 *
 * Usage:
 *   STORE_ID=<uuid> npm run seed:configs -w @tcg/api
 *
 * After running, remove the legacy env vars; day-to-day rotation happens
 * through the settings UI.
 */
import { ConfigService } from '../server/services/config-service';
import { getDb, getPool, schema } from '../db/client';
import { eq } from 'drizzle-orm';

async function main(): Promise<void> {
  const storeId = process.env.SEED_STORE_ID ?? process.env.STORE_ID;
  if (!storeId) {
    throw new Error('SEED_STORE_ID (or STORE_ID) must be set');
  }

  const db = getDb();
  const configs = new ConfigService(db);

  const [store] = await db
    .select({ id: schema.stores.id })
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .limit(1);
  if (!store) throw new Error(`store ${storeId} not found`);

  const tcgapiKey = process.env.TCGAPI_KEY;
  const tcgapiBase = process.env.TCGAPI_BASE_URL ?? 'https://api.tcgapi.dev/v1';
  if (tcgapiKey) {
    const status = await configs.getTcgapiStatus(storeId);
    if (status.configured) {
      // eslint-disable-next-line no-console
      console.log(`[seed] tcgapi config already present for store ${storeId} — skipping`);
    } else {
      await configs.upsertTcgapi({ storeId, baseUrl: tcgapiBase, apiKey: tcgapiKey });
      // eslint-disable-next-line no-console
      console.log('[seed] inserted tcgapi_configs row');
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('[seed] TCGAPI_KEY not set; skipping tcgapi import');
  }

  const cloverToken = process.env.CLOVER_ACCESS_TOKEN;
  const cloverMerchant = process.env.CLOVER_MERCHANT_ID;
  const cloverBase = process.env.CLOVER_BASE_URL ?? 'https://sandbox.dev.clover.com';
  const cloverSecret = process.env.CLOVER_WEBHOOK_SIGNING_SECRET;
  if (cloverToken && cloverMerchant && cloverSecret) {
    const status = await configs.getPosStatus(storeId);
    if (status.configured) {
      // eslint-disable-next-line no-console
      console.log(`[seed] pos config already present for store ${storeId} — skipping`);
    } else {
      await configs.upsertPos({
        storeId,
        baseUrl: cloverBase,
        merchantId: cloverMerchant,
        accessToken: cloverToken,
        webhookSigningSecret: cloverSecret,
      });
      // eslint-disable-next-line no-console
      console.log('[seed] inserted pos_configs row');
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('[seed] CLOVER_* env vars incomplete; skipping pos import');
  }

  await getPool().end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
