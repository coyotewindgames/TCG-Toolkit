import { z } from 'zod';

/**
 * Card condition grades, in descending quality order.
 * Used across pricing tiers and trade-in valuation.
 */
export const CARD_CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const;
export type CardCondition = (typeof CARD_CONDITIONS)[number];

export const CARD_PRINTINGS = ['Normal', 'Foil', 'Reverse', 'Holo', 'FirstEdition'] as const;
export type CardPrinting = (typeof CARD_PRINTINGS)[number];

export const CARD_LANGUAGES = ['EN', 'JP', 'DE', 'FR', 'IT', 'ES', 'PT', 'KO', 'CN'] as const;
export type CardLanguage = (typeof CARD_LANGUAGES)[number];

export const USER_ROLES = ['owner', 'manager', 'clerk', 'buyer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PRICE_SOURCES = [
  'tcgapi_market',
  'tcgapi_low',
  'tcgapi_median',
  'tcgapi_buylist',
  'manual_override',
] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const ORDER_STATUSES = [
  'open',
  'pending_payment',
  'paid',
  'voided',
  'refunded',
  'partially_refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TRADE_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'completed',
] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

export const PAYOUT_KINDS = ['cash', 'store_credit'] as const;
export type PayoutKind = (typeof PAYOUT_KINDS)[number];

/** Allowed POS provider literal. Clover is the exclusive payment processor. */
export const POS_PROVIDERS = ['clover'] as const;
export type PosProviderName = (typeof POS_PROVIDERS)[number];

export const GAMES = [
  'mtg',
  'pokemon',
  'yugioh',
  'lorcana',
  'one_piece',
  'flesh_and_blood',
  'sealed',
  'supplies',
  'other',
] as const;
export type Game = (typeof GAMES)[number];

// ---------- Request / response DTOs ----------

export const ScanRequest = z.object({
  barcode: z.string().min(3).max(128),
  orderId: z.string().uuid().optional(),
  registerId: z.string().min(1).optional(),
});
export type ScanRequest = z.infer<typeof ScanRequest>;

export const ScanResponse = z.object({
  skuId: z.string().uuid(),
  productId: z.string().uuid(),
  name: z.string(),
  setName: z.string().nullable(),
  cardNumber: z.string().nullable(),
  condition: z.enum(CARD_CONDITIONS),
  printing: z.enum(CARD_PRINTINGS),
  language: z.enum(CARD_LANGUAGES),
  imageUrl: z.string().url().nullable(),
  priceCents: z.number().int().nonnegative(),
  stockOnHand: z.number().int().nonnegative(),
  stockReserved: z.number().int().nonnegative(),
});
export type ScanResponse = z.infer<typeof ScanResponse>;

export const CreateOrderRequest = z.object({
  locationId: z.string().uuid(),
  registerId: z.string().min(1).optional(),
  customerId: z.string().uuid().optional(),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

export const CheckoutRequest = z.object({
  provider: z.enum(POS_PROVIDERS).default('clover'),
  deviceId: z.string().min(1),
  tipCents: z.number().int().nonnegative().optional(),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const SignupRequest = z.object({
  storeName: z.string().min(2).max(120),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8).max(128),
  ownerName: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64).optional(),
});
export type SignupRequest = z.infer<typeof SignupRequest>;

export const ForgotPasswordRequest = z.object({
  email: z.string().email(),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequest>;

export const ResetPasswordRequest = z.object({
  token: z.string().min(16).max(256),
  password: z.string().min(8).max(128),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

export const LocationSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type LocationSummary = z.infer<typeof LocationSummary>;

export const CreateLocationRequest = z.object({
  name: z.string().min(1).max(120),
});
export type CreateLocationRequest = z.infer<typeof CreateLocationRequest>;

export const AuthTokens = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  user: z.object({
    id: z.string().uuid(),
    storeId: z.string().uuid(),
    email: z.string().email(),
    role: z.enum(USER_ROLES),
    displayName: z.string(),
  }),
});
export type AuthTokens = z.infer<typeof AuthTokens>;

export const TradeItemInput = z.object({
  skuId: z.string().uuid().optional(),
  // If no SKU yet (brand-new card to the store) accept lookup hints:
  tcgapiProductId: z.string().min(1).optional(),
  game: z.enum(GAMES).optional(),
  name: z.string().min(1).optional(),
  condition: z.enum(CARD_CONDITIONS),
  printing: z.enum(CARD_PRINTINGS),
  language: z.enum(CARD_LANGUAGES).default('EN'),
  quantity: z.number().int().positive(),
  // Overrides for the suggested trade value (cents per unit):
  overrideValueCents: z.number().int().nonnegative().optional(),
});
export type TradeItemInput = z.infer<typeof TradeItemInput>;

export const CreateTradeRequest = z.object({
  locationId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  payout: z.enum(PAYOUT_KINDS),
  items: z.array(TradeItemInput).min(1),
});
export type CreateTradeRequest = z.infer<typeof CreateTradeRequest>;

// ---------- Realtime socket events ----------

export interface CartItemAddedEvent {
  orderId: string;
  line: {
    id: string;
    skuId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    imageUrl: string | null;
  };
  totals: { subtotalCents: number; taxCents: number; totalCents: number };
}

export interface CartItemRemovedEvent {
  orderId: string;
  lineId: string;
  totals: { subtotalCents: number; taxCents: number; totalCents: number };
}

export interface InventoryUpdatedEvent {
  skuId: string;
  qtyOnHand: number;
  qtyReserved: number;
  marketPriceCents: number | null;
}

export interface OrderCompletedEvent {
  orderId: string;
  totalCents: number;
  paymentProvider: PosProviderName;
  receiptUrl: string | null;
}

export interface TradeCreatedEvent {
  tradeId: string;
  totalValueCents: number;
  status: TradeStatus;
}

export const SOCKET_EVENTS = {
  cartItemAdded: 'cart.itemAdded',
  cartItemRemoved: 'cart.itemRemoved',
  cartTotals: 'cart.totals',
  inventoryUpdated: 'inventory.updated',
  orderCompleted: 'order.completed',
  orderRefunded: 'order.refunded',
  tradeCreated: 'tradein.created',
  tradeApproved: 'tradein.approved',
} as const;

// ---------- Helpers ----------

/** Deterministically hash a SKU identity for de-duplication. */
export function skuIdentityKey(args: {
  tcgapiProductId?: string | null;
  condition: CardCondition;
  printing: CardPrinting;
  language: CardLanguage;
}): string {
  return [
    args.tcgapiProductId ?? 'NULL',
    args.condition,
    args.printing,
    args.language,
  ].join('|');
}
