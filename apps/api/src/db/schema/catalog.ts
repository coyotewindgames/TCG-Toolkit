/** Card catalog: products, SKUs and their prices. */
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  jsonb,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { cardConditionEnum, cardGradingCompanyEnum, cardPrintingEnum, cardLanguageEnum, priceSourceEnum, gameEnum } from './enums';
import { stores } from './core';

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    tcgapiProductId: text('tcgapi_product_id'),
    pkmnpricesProductId: integer('pkmnprices_product_id'),
    game: gameEnum('game').notNull().default('other'),
    name: text('name').notNull(),
    setName: text('set_name'),
    setId: text('set_id'),
    cardNumber: text('card_number'),
    rarity: text('rarity'),
    type: text('type'),
    /** Card illustrator. Populated from pkmnprices for Pokemon products. */
    artist: text('artist'),
    imageSourceUrl: text('image_source_url'),
    /**
     * When true, the automated image-enrichment job leaves this row alone.
     * Flipped by the manual "Edit image" flow so a user-uploaded (or
     * user-cleared) image isn't overwritten by the next enrichment pass.
     */
    imageLocked: boolean('image_locked').notNull().default(false),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    searchTsv: text('search_tsv'), // generated tsvector; actual GENERATED column added in migration
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStore: index('products_store_idx').on(t.storeId),
    byTcgapi: index('products_tcgapi_idx').on(t.tcgapiProductId),
    byPkmnprices: index('products_pkmnprices_idx').on(t.pkmnpricesProductId),
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
    /**
     * In-house condition tier. Null for graded SKUs, where `gradingCompany` +
     * `grade` describe the card instead (enforced by the `skus_grade_ck`
     * CHECK constraint added in migration 0018).
     */
    condition: cardConditionEnum('condition'),
    printing: cardPrintingEnum('printing').notNull(),
    language: cardLanguageEnum('language').notNull().default('EN'),
    /** Third-party grading company for slabbed cards; null for raw singles. */
    gradingCompany: cardGradingCompanyEnum('grading_company'),
    /** Grade value as a string ("10", "9.5") — graders use different scales. */
    grade: varchar('grade', { length: 8 }),
    /** Slab certification number; indexed for later duplicate-cert detection. */
    certNumber: text('cert_number'),
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
      t.gradingCompany,
      t.grade,
    ).nullsNotDistinct(),
    byProduct: index('skus_product_idx').on(t.productId),
    byCert: index('skus_cert_idx').on(t.certNumber),
  }),
);


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
