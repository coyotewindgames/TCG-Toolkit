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
export * from './enums';
export * from './core';
export * from './catalog';
export * from './inventory';
export * from './orders';
export * from './trades';
export * from './audit';
export * from './auth';
export * from './config';
