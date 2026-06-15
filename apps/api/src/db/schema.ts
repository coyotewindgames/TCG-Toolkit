/**
 * Drizzle schema for the TCG Toolkit.
 *
 * Design notes:
 * - Every operational table carries `storeId` and where relevant `locationId`
 *   so multi-store/multi-location is supported from day one.
 * - Money is stored in **integer cents** to avoid float drift.
 * - Timestamps use `timestamptz`; display layer converts to the store's TZ.
 * - `webhookEvents` is the single source of idempotency for inbound webhooks.
 * - `priceSnapshots` is append-only, partitionable by month (see migration).
 */
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  pgEnum,
  unique,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------- enums ----------

export const cardConditionEnum = pgEnum('card_condition', ['NM', 'LP', 'MP', 'HP', 'DMG']);
export const cardPrintingEnum = pgEnum('card_printing', [
  'Normal',
  'Foil',
  'Reverse',
  'Holo',
  'FirstEdition',
]);
export const cardLanguageEnum = pgEnum('card_language', [
  'EN',
  'JP',
  'DE',
  'FR',
  'IT',
  'ES',
  'PT',
  'KO',
  'CN',
]);
export const userRoleEnum = pgEnum('user_role', ['owner', 'manager', 'clerk', 'buyer']);
export const orderStatusEnum = pgEnum('order_status', [
  'open',
  'pending_payment',
  'paid',
  'voided',
  'refunded',
  'partially_refunded',
]);
export const tradeStatusEnum = pgEnum('trade_status', [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'completed',
]);
export const payoutKindEnum = pgEnum('payout_kind', ['cash', 'store_credit']);
// Clover is the exclusive POS provider for this system.
export const posProviderEnum = pgEnum('pos_provider', ['clover']);
export const priceSourceEnum = pgEnum('price_source', [
  'tcgapi_market',
  'tcgapi_low',
  'tcgapi_median',
  'tcgapi_buylist',
  'manual_override',
]);
export const gameEnum = pgEnum('game', [
  'mtg',
  'pokemon',
  'yugioh',
  'lorcana',
  'one_piece',
  'flesh_and_blood',
  'sealed',
  'supplies',
  'other',
]);

// ---------- tenancy ----------

export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/New_York'),
  defaultPosProvider: posProviderEnum('default_pos_provider').notNull().default('clover'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when the owner completes (or dismisses) the onboarding wizard. */
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
});

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address: jsonb('address').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStore: index('locations_store_idx').on(t.storeId),
  }),
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    role: userRoleEnum('role').notNull().default('clerk'),
    passwordHash: text('password_hash'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailPerStore: unique('users_email_store_uq').on(t.storeId, t.email),
  }),
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text('name'),
    email: text('email'),
    phone: text('phone'),
    storeCreditCents: bigint('store_credit_cents', { mode: 'number' }).notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStore: index('customers_store_idx').on(t.storeId),
    byEmail: index('customers_email_idx').on(t.email),
  }),
);

// ---------- catalog ----------

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    tcgapiProductId: text('tcgapi_product_id'),
    game: gameEnum('game').notNull().default('other'),
    name: text('name').notNull(),
    setName: text('set_name'),
    setId: text('set_id'),
    cardNumber: text('card_number'),
    rarity: text('rarity'),
    type: text('type'),
    imageSourceUrl: text('image_source_url'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    searchTsv: text('search_tsv'), // generated tsvector; actual GENERATED column added in migration
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStore: index('products_store_idx').on(t.storeId),
    byTcgapi: index('products_tcgapi_idx').on(t.tcgapiProductId),
    nameIdx: index('products_name_idx').on(t.name),
    importIdentityIdx: index('products_import_identity_idx').on(
      t.storeId,
      t.game,
      t.name,
      t.setName,
      t.cardNumber,
    ),
  }),
);

export const skus = pgTable(
  'skus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    condition: cardConditionEnum('condition').notNull(),
    printing: cardPrintingEnum('printing').notNull(),
    language: cardLanguageEnum('language').notNull().default('EN'),
    /** Always equal to skus.id. Kept as a dedicated column so the unique
     *  scanner-lookup index (`skus_barcode_uq`) is independent of PK type. */
    barcode: varchar('barcode', { length: 64 }).notNull(),
    internalSku: varchar('internal_sku', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    barcodeUq: unique('skus_barcode_uq').on(t.barcode),
    identityUq: unique('skus_identity_uq').on(
      t.productId,
      t.condition,
      t.printing,
      t.language,
    ),
    byProduct: index('skus_product_idx').on(t.productId),
  }),
);

// ---------- inventory ----------

export const inventory = pgTable(
  'inventory',
  {
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    qtyOnHand: integer('qty_on_hand').notNull().default(0),
    qtyReserved: integer('qty_reserved').notNull().default(0),
    costAvgCents: integer('cost_avg_cents').notNull().default(0),
    bin: text('bin'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skuId, t.locationId] }),
    byLocation: index('inventory_location_idx').on(t.locationId),
  }),
);

// ---------- pricing ----------

export const priceSnapshots = pgTable(
  'price_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    source: priceSourceEnum('source').notNull(),
    priceCents: integer('price_cents').notNull(),
    sampleSize: integer('sample_size'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySku: index('price_snapshots_sku_idx').on(t.skuId, t.capturedAt),
    bySource: index('price_snapshots_source_idx').on(t.source, t.capturedAt),
  }),
);

/**
 * Current effective price per SKU — denormalized for fast scan resolution.
 * Updated by the pricing worker after every refresh.
 */
export const currentPrices = pgTable('current_prices', {
  skuId: uuid('sku_id')
    .primaryKey()
    .references(() => skus.id, { onDelete: 'cascade' }),
  sellPriceCents: integer('sell_price_cents').notNull(),
  buyPriceCents: integer('buy_price_cents').notNull().default(0),
  marketPriceCents: integer('market_price_cents'),
  marketMedianCents: integer('market_median_cents'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- orders ----------

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    registerId: text('register_id'),
    status: orderStatusEnum('status').notNull().default('open'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    tipCents: integer('tip_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    posProvider: posProviderEnum('pos_provider'),
    posOrderId: text('pos_order_id'),
    posCheckoutId: text('pos_checkout_id'),
    receiptUrl: text('receipt_url'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    byStore: index('orders_store_idx').on(t.storeId, t.status),
    byPos: index('orders_pos_idx').on(t.posOrderId),
  }),
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    // Snapshot of price at scan time so price drift doesn't change the cart.
    unitPriceCents: integer('unit_price_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    // Snapshots taken at scan time so receipt reprints stay accurate even after
    // the product is renamed or tax rates change.
    productNameSnapshot: text('product_name_snapshot'),
    taxRateBps: integer('tax_rate_bps').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrder: index('order_items_order_idx').on(t.orderId),
  }),
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    provider: posProviderEnum('provider').notNull(),
    providerPaymentId: text('provider_payment_id'),
    amountCents: integer('amount_cents').notNull(),
    status: text('status').notNull(), // 'authorized' | 'captured' | 'failed' | 'refunded'
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrder: index('payments_order_idx').on(t.orderId),
  }),
);

// ---------- trade-ins ----------

export const tradeIns = pgTable(
  'trade_ins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    status: tradeStatusEnum('status').notNull().default('draft'),
    payout: payoutKindEnum('payout').notNull(),
    totalValueCents: integer('total_value_cents').notNull().default(0),
    signatureUrl: text('signature_url'),
    idImageUrl: text('id_image_url'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    barcode: varchar('barcode', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    barcodeUq: unique('trade_ins_barcode_uq').on(t.barcode),
    byCustomer: index('trade_ins_customer_idx').on(t.customerId),
  }),
);

export const tradeItems = pgTable(
  'trade_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tradeId: uuid('trade_id')
      .notNull()
      .references(() => tradeIns.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    unitValueCents: integer('unit_value_cents').notNull(),
    barcode: varchar('barcode', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTrade: index('trade_items_trade_idx').on(t.tradeId),
  }),
);

// ---------- audit + idempotency ----------

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byEntity: index('audit_entity_idx').on(t.entity, t.entityId),
    byActor: index('audit_actor_idx').on(t.actorId),
  }),
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(), // always 'clover'
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    signatureOk: boolean('signature_ok').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique('webhook_events_provider_id_uq').on(t.provider, t.providerEventId),
    byType: index('webhook_events_type_idx').on(t.provider, t.eventType),
    bySignature: index('webhook_events_signature_idx').on(t.signatureOk, t.receivedAt),
  }),
);

// ---------- auth ----------

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index('refresh_tokens_user_idx').on(t.userId),
    hashUq: unique('refresh_tokens_hash_uq').on(t.tokenHash),
  }),
);

/**
 * One-time tokens for the "forgot password" flow. The plaintext token is
 * emailed to the user; only its SHA-256 hash lives here. A row is "spent"
 * after `consumedAt` is set, and ignored after `expiresAt` passes — both
 * checks happen at consume-time so we never accept a replay.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestedIp: text('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUq: unique('password_resets_hash_uq').on(t.tokenHash),
    byUser: index('password_resets_user_idx').on(t.userId),
  }),
);

// Default raw SQL builders used by migrations.
export const generatedColumns = {
  productSearchTsv: sql`to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(set_name,'') || ' ' || coalesce(card_number,''))`,
};

// ---------- integration credentials (encrypted per store) ----------
//
// Third-party API credentials (TCGapi.dev, Clover) live here, encrypted with
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

export const tcgapiConfigs = pgTable('tcgapi_configs', {
  storeId: uuid('store_id')
    .primaryKey()
    .references(() => stores.id, { onDelete: 'cascade' }),
  baseUrl: text('base_url').notNull().default('https://api.tcgapi.dev/v1'),
  apiKeyCiphertext: text('api_key_ciphertext').notNull(),
  apiKeyIv: text('api_key_iv').notNull(),
  apiKeyTag: text('api_key_tag').notNull(),
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
    tableName: text('table_name').notNull(), // 'tcgapi_configs' | 'pos_configs'
    action: text('action').notNull(), // 'create' | 'update' | 'rotate' | 'delete' | 'verify'
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorIp: text('actor_ip'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStore: index('config_audit_store_idx').on(t.storeId, t.at),
  }),
);

