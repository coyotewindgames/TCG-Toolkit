/** Refresh tokens and password reset tokens. */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './core';

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
