/** Sales: orders, their line items and payments. */
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { orderStatusEnum, posProviderEnum } from './enums';
import { skus } from './catalog';
import { customers, locations, stores, users } from './core';

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

export const orderMutationRequests = pgTable(
  'order_mutation_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    clientRequestId: text('client_request_id').notNull(),
    action: text('action').notNull(),
    responseSnapshot: jsonb('response_snapshot').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique('order_mutation_requests_store_client_uq').on(t.storeId, t.clientRequestId),
    byOrder: index('order_mutation_requests_order_idx').on(t.orderId),
  }),
);
