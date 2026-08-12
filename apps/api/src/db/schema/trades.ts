/** Trade-ins and the items customers bring in. */
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { tradeStatusEnum, payoutKindEnum } from './enums';
import { skus } from './catalog';
import { customers, locations, stores, users } from './core';

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
    totalBuyValueCents: integer('total_buy_value_cents').notNull().default(0),
    totalMarketValueCents: integer('total_market_value_cents').notNull().default(0),
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
    marketPriceCents: integer('market_price_cents'),
    barcode: varchar('barcode', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTrade: index('trade_items_trade_idx').on(t.tradeId),
  }),
);
