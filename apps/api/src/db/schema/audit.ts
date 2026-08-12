/** Audit trail and inbound webhook idempotency. */
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { stores, users } from './core';

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
