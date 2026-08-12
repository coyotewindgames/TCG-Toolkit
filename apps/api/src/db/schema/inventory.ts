/** On-hand quantities per location. */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { skus } from './catalog';
import { locations } from './core';

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
