/**
 * Maps the many header spellings found in store exports onto the canonical
 * column names the import pipeline understands.
 */
import { normalizeAlphanumeric } from '@tcg/shared';
import type { ParsedCsvRow } from './types';

/** All accepted header synonyms -> canonical key. */
const HEADER_SYNONYMS: Record<string, string> = {
  // name
  name: 'name',
  cardname: 'name',
  productname: 'name',
  title: 'name',
  // set
  set: 'set',
  setname: 'set',
  expansion: 'set',
  // set code
  setcode: 'setCode',
  setid: 'setCode',
  // card number
  number: 'cardNumber',
  cardnumber: 'cardNumber',
  collectornumber: 'cardNumber',
  no: 'cardNumber',
  // rarity
  rarity: 'rarity',
  // game
  game: 'game',
  tcg: 'game',
  category: 'game',
  // variant / printing
  variant: 'printing',
  variance: 'printing',
  foil: 'printing',
  finish: 'printing',
  printing: 'printing',
  edition: 'printing',
  // condition
  condition: 'condition',
  cond: 'condition',
  cardcondition: 'condition',
  // language
  language: 'language',
  lang: 'language',
  // qty
  quantity: 'qty',
  qty: 'qty',
  count: 'qty',
  // prices
  purchaseprice: 'costCents',
  purchasecost: 'costCents',
  buyprice: 'costCents',
  costbasis: 'costCents',
  cost: 'costCents',
  unitcost: 'costCents',
  itemcost: 'costCents',
  yourprice: 'costCents',
  pricepaid: 'costCents',
  paid: 'costCents',
  averagecostpaid: 'costCents',
  marketprice: 'marketCents',
  marketpriceusd: 'marketCents',
  marketpricecad: 'marketCents',
  marketpriceaud: 'marketCents',
  market: 'marketCents',
  tcgmarket: 'marketCents',
  tcgmarketprice: 'marketCents',
  tcgmarketpriceusd: 'marketCents',
  tcgplayermarketprice: 'marketCents',
  price: 'marketCents',
  currentvalue: 'marketCents',
  marketvalue: 'marketCents',
  marketvalueusd: 'marketCents',
};

/** Resolves a raw CSV header to its canonical column name, if recognized. */
export function normalizeHeaderName(header: string): string | undefined {
  const normalizedHeader = normalizeAlphanumeric(header);
  return (
    HEADER_SYNONYMS[normalizedHeader] ??
    (normalizedHeader.startsWith('marketpriceasof') ? 'marketCents' : undefined)
  );
}

/**
 * Indexes the header row by canonical column name. The first header that maps
 * to a canonical name wins, matching how stores duplicate price columns.
 */
export function indexHeaders(headers: string[]): Record<string, number> {
  const indexByCanonicalName: Record<string, number> = {};
  headers.forEach((header, position) => {
    const canonicalName = normalizeHeaderName(header);
    if (canonicalName && indexByCanonicalName[canonicalName] === undefined) {
      indexByCanonicalName[canonicalName] = position;
    }
  });
  return indexByCanonicalName;
}

/** Rewrites one raw CSV row so its keys are canonical column names. */
export function mapRowToCanonicalColumns(row: ParsedCsvRow): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [header, value] of Object.entries(row)) {
    const canonicalName = normalizeHeaderName(header);
    if (canonicalName && mapped[canonicalName] === undefined) {
      mapped[canonicalName] = value;
    }
  }
  return mapped;
}
