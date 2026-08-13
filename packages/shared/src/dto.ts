/**
 * Response/DTO shapes exchanged between the Express API and the web client.
 *
 * These live here — rather than being retyped per page or per hook — so a
 * change to an endpoint's payload surfaces as a type error in every consumer.
 */
import type { CardCondition, CardLanguage, CardPrinting, PayoutKind } from './index';

/** A card as returned by the catalog proxy endpoints (`/pkmnprices/*`). */
export interface CatalogCard {
  id: string;
  name: string;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  setId: string | null;
  setName: string | null;
  gameSlug: string | null;
  gameName: string | null;
  artist?: string | null;
}

/** `GET /pkmnprices/search` */
export interface CatalogSearchResponse {
  results: CatalogCard[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total: number | null;
  matchedBy?: 'name' | 'artist';
}

/** `GET /pkmncards/artist-search` */
export interface CatalogArtistSearchResponse {
  results: CatalogCard[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total: number;
  resolvedArtist: { slug: string; displayName: string; method: string } | null;
}

/** One entry of `GET /pkmnprices/sets`. */
export interface CatalogSetSummary {
  id: string;
  name: string;
  slug?: string;
}

export interface CatalogSetsResponse {
  sets: CatalogSetSummary[];
}

/** One per-printing price row from `GET /pkmnprices/cards/:id/prices`. */
export interface CatalogPriceRow {
  cardId: string;
  printing: string;
  marketCents: number | null;
  lowCents: number | null;
  medianCents: number | null;
  buylistCents: number | null;
  lastUpdatedAt: string | null;
}

export interface CatalogPricesResponse {
  cardId: string;
  prices: CatalogPriceRow[];
}

/** `POST /tradeins` */
export interface CreateTradeResponse {
  id: string;
  status: string;
  totalValueCents: number;
  skuIds: Array<{ skuId: string; quantity: number }>;
}

/** One row of `GET /tradeins` — the transaction history table. */
export interface TradeListItem {
  id: string;
  createdAt: string;
  completedAt: string | null;
  status: string;
  payout: string;
  totalValueCents: number;
  customerName: string | null;
  locationName: string;
  itemCount: number;
}

/** `GET /tradeins` */
export interface TradeListResponse {
  results: TradeListItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

/** One line of the register cart, as rendered by the web client. */
export interface OrderLineView {
  id: string;
  skuId: string;
  name: string;
  condition: string;
  unitPriceCents: number;
  qty: number;
  imageUrl?: string;
  qtyRemaining?: number;
}

export interface OrderTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/** `POST /orders/:id/items` */
export interface AddOrderItemResponse {
  line: {
    id: string;
    skuId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    imageUrl?: string | null;
  };
  totals: OrderTotals;
}

/** `GET /orders/:id` */
export interface OrderDetailResponse {
  order: OrderTotals;
  items: Array<{
    id: string;
    skuId: string;
    quantity: number;
    unitPriceCents: number;
    productNameSnapshot: string | null;
    condition: string;
    imageUrl: string | null;
    qtyRemaining: number;
  }>;
}

/** One row of `GET /products/search`. */
export interface ProductSearchItem {
  id: string;
  name: string;
  setName: string | null;
  cardNumber: string | null;
  imageSourceUrl?: string | null;
  availableQty: number;
  minSellPriceCents: number | null;
  maxSellPriceCents: number | null;
}

export interface ProductSearchResponse {
  results: ProductSearchItem[];
}

/** One row of `GET /products/:id/skus`. */
export interface ProductSkuSummary {
  id: string;
  barcode: string;
  condition: string;
  printing: string;
  language: string;
  sellPriceCents: number | null;
  availableQty: number;
}

export interface ProductSkusResponse {
  skus: ProductSkuSummary[];
}

/** A trade line staged in the browser before the trade is submitted. */
export interface QueuedTradeItem {
  id: string;
  tcgapiProductId: string;
  name: string;
  imageSourceUrl: string | null;
  rarity: string | null;
  condition: CardCondition;
  printing: CardPrinting;
  language: CardLanguage;
  gradingCompany?: string;
  grade?: string;
  certNumber?: string;
  quantity: number;
  payoutModifierPercent: number;
  overrideValueCents?: number;
  marketPriceCents: number | null;
  estimatedUnitValueCents: number;
}

/**
 * Fraction of market value paid out per payout kind. The server recomputes
 * payouts authoritatively on submit; the client uses these for its preview.
 */
export const TRADE_PAYOUT_MULTIPLIERS: Record<PayoutKind, number> = {
  cash: 0.7,
  store_credit: 0.8,
};

/**
 * Catalog language axis accepted by the PkmnPrices proxy. Distinct from
 * `CARD_LANGUAGES`, which is the language printed on a physical card.
 */
export const CATALOG_LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'english', label: 'English' },
  { value: 'japanese', label: 'Japanese (Pro tier)' },
];
