/** Store-level integration configuration and its audit trail. */
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { posProviderEnum } from './enums';
import { stores, users } from './core';

export const generatedColumns = {
  productSearchTsv: sql`to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(set_name,'') || ' ' || coalesce(card_number,''))`,
};

//
// Third-party API credentials (PkmnPrices, Clover) live here, encrypted with
// AES-256-GCM via `crypto-vault.ts`. The plaintext is never persisted, never
// logged, and never returned by the settings API — only "hasKey" booleans are
// surfaced to the UI. The encryption key itself (CONFIG_ENCRYPTION_KEY) lives
// only in process env so a stolen `pg_dump` is useless without it.
//
// Schema choices:
//   - GCM produces a 12-byte IV and a 16-byte auth tag, kept in dedicated
//     `bytea` columns to keep "decrypt this" purely about column lookup.
//   - `key_version` lets us rotate `CONFIG_ENCRYPTION_KEY` without a
//     migration: callers try the current key first, then fall back to older
//     keys keyed by version.
//   - `last_verified_at` is touched by the explicit "Verify" UI action so
//     operators can see whether saved creds still authenticate upstream.

/**
 * Per-store credentials for the PkmnPrices.com pricing API. Pokémon-only, so
 * no game filter list is stored.
 */
export const pkmnpricesConfigs = pgTable('pkmnprices_configs', {
  storeId: uuid('store_id')
    .primaryKey()
    .references(() => stores.id, { onDelete: 'cascade' }),
  baseUrl: text('base_url').notNull().default('https://api.pkmnprices.com/v1'),
  apiKeyCiphertext: text('api_key_ciphertext').notNull(),
  apiKeyIv: text('api_key_iv').notNull(),
  apiKeyTag: text('api_key_tag').notNull(),
  /** Owner-declared tier so the router can decide whether to attempt JP lookups. */
  tier: text('tier').notNull().default('free'), // 'free' | 'pro' | 'business'
  keyVersion: integer('key_version').notNull().default(1),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const posConfigs = pgTable(
  'pos_configs',
  {
    storeId: uuid('store_id')
      .primaryKey()
      .references(() => stores.id, { onDelete: 'cascade' }),
    provider: posProviderEnum('provider').notNull().default('clover'),
    baseUrl: text('base_url').notNull(),
    // merchantId stays plaintext because the webhook handler must locate the
    // store from the inbound `merchants[0].id` before it has a chance to
    // decrypt anything else.
    merchantId: text('merchant_id').notNull(),
    accessTokenCiphertext: text('access_token_ciphertext').notNull(),
    accessTokenIv: text('access_token_iv').notNull(),
    accessTokenTag: text('access_token_tag').notNull(),
    webhookSecretCiphertext: text('webhook_secret_ciphertext').notNull(),
    webhookSecretIv: text('webhook_secret_iv').notNull(),
    webhookSecretTag: text('webhook_secret_tag').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    merchantUq: unique('pos_configs_merchant_uq').on(t.merchantId),
  }),
);

/**
 * Append-only audit trail for credential mutations. Intentionally records no
 * before/after secret values — only who changed what, when, and from where.
 */
export const configAuditLog = pgTable(
  'config_audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(), // 'pkmnprices_configs' | 'pos_configs'
    action: text('action').notNull(), // 'create' | 'update' | 'rotate' | 'delete' | 'verify'
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorIp: text('actor_ip'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStore: index('config_audit_store_idx').on(t.storeId, t.at),
  }),
);
