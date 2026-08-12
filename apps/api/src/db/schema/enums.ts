/** Enum types shared across every schema module. */
import {
  pgEnum,
} from 'drizzle-orm/pg-core';

export const cardConditionEnum = pgEnum('card_condition', ['NM', 'LP', 'MP', 'HP', 'DMG']);
/**
 * Third-party grading companies. A graded SKU's `condition` is null — the slab
 * grade supersedes the in-house NM/LP/... tier (enforced by a CHECK constraint).
 */
export const cardGradingCompanyEnum = pgEnum('card_grading_company', [
  'psa',
  'cgc',
  'beckett',
  'tag',
  'sgc',
  'other',
]);
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
  'pkmnprices_market',
  'pkmnprices_low',
  'pkmnprices_cardmarket',
  'pkmnprices_graded_ebay',
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
