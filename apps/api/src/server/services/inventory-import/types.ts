/** Shared vocabulary for the CSV inventory import pipeline. */

export type ParsedCsvRow = Record<string, string>;

export const IMPORT_GAMES = [
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

export type Game = (typeof IMPORT_GAMES)[number];
export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';
export type Printing = 'Normal' | 'Foil' | 'Reverse' | 'Holo' | 'FirstEdition';
export type Language = 'EN' | 'JP' | 'DE' | 'FR' | 'IT' | 'ES' | 'PT' | 'KO' | 'CN';

export interface ImportRequest {
  csv: string;
  locationId: string;
  defaultCondition?: Condition;
  defaultPrinting?: Printing;
  dryRun?: boolean;
}

export interface ImportResult {
  totalRows: number;
  productsCreated: number;
  skusCreated: number;
  inventoryCreated: number;
  inventoryUpdated: number;
  costsApplied: number;
  pricesSeeded: number;
  marketPricesApplied: number;
  errors: Array<{ row: number; message: string; data?: Record<string, string> }>;
  dryRun: boolean;
}

/** A CSV row that passed validation and is ready to be persisted. */
export interface ImportRecord {
  rowIndex: number;
  rawRow: ParsedCsvRow;
  game: Game;
  name: string;
  setName: string | null;
  setCode: string | null;
  cardNumber: string | null;
  rarity: string | null;
  condition: Condition;
  printing: Printing;
  language: Language;
  qty: number;
  costCents: number | null;
  marketCents: number | null;
  productKey: string;
}

export interface ProductCandidate {
  productKey: string;
  game: Game;
  name: string;
  setName: string | null;
  setCode: string | null;
  cardNumber: string | null;
  rarity: string | null;
}

export interface SkuCandidate {
  skuKey: string;
  id: string;
  productId: string;
  condition: Condition;
  printing: Printing;
  language: Language;
}

export interface InventoryWithCostPayload {
  skuId: string;
  locationId: string;
  qty: number;
  weightedCostCents: number;
}

export interface InventoryWithoutCostPayload {
  skuId: string;
  locationId: string;
  qty: number;
}

export interface CurrentPricePayload {
  skuId: string;
  marketCents: number;
}

export function productIdentityKey(args: {
  storeId: string;
  game: Game;
  name: string;
  setName: string | null;
  cardNumber: string | null;
}): string {
  return [args.storeId, args.game, args.name, args.setName ?? '', args.cardNumber ?? ''].join('|');
}

export function inventoryIdentityKey(args: { skuId: string; locationId: string }): string {
  return `${args.skuId}|${args.locationId}`;
}
