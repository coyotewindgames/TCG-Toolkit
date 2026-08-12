/** Tenancy and people: stores, locations, users, customers. */
import {
  pgTable,
  uuid,
  text,
  bigint,
  jsonb,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { userRoleEnum, posProviderEnum } from './enums';

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
