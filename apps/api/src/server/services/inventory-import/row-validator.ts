/**
 * Turns a raw CSV row into a validated `ImportRecord`, coercing the free-form
 * game/condition/printing/language/quantity/price values stores export.
 */
import { normalizeAlphanumeric } from '@tcg/shared';
import { mapRowToCanonicalColumns } from './header-mapper';
import {
  productIdentityKey,
  type Condition,
  type Game,
  type ImportRecord,
  type Language,
  type ParsedCsvRow,
  type Printing,
} from './types';

export function toGame(value: string | undefined): Game {
  const normalized = normalizeAlphanumeric(value ?? '');
  if (!normalized) return 'other';
  if (normalized.includes('magic') || normalized === 'mtg') return 'mtg';
  if (normalized.includes('pokemon') || normalized.includes('pokmon') || normalized === 'pkm') return 'pokemon';
  if (normalized.includes('yugioh') || normalized.includes('yu')) return 'yugioh';
  if (normalized.includes('lorcana')) return 'lorcana';
  if (normalized.includes('onepiece')) return 'one_piece';
  if (normalized.includes('fleshandblood') || normalized === 'fab') return 'flesh_and_blood';
  if (normalized.includes('sealed')) return 'sealed';
  if (normalized.includes('supply') || normalized.includes('supplies')) return 'supplies';
  return 'other';
}

export function toCondition(value: string | undefined, fallback: Condition): Condition {
  const normalized = normalizeAlphanumeric(value ?? '');
  if (!normalized) return fallback;
  if (normalized.startsWith('nm') || normalized.includes('nearmint') || normalized === 'm' || normalized === 'mint')
    return 'NM';
  if (normalized.startsWith('lp') || normalized.includes('lightlyplayed') || normalized.includes('excellent'))
    return 'LP';
  if (normalized.startsWith('mp') || normalized.includes('moderatelyplayed') || normalized.includes('played'))
    return 'MP';
  if (normalized.startsWith('hp') || normalized.includes('heavilyplayed') || normalized.includes('poor')) return 'HP';
  if (normalized.startsWith('dmg') || normalized.includes('damaged')) return 'DMG';
  throw new Error(`unrecognized condition "${value}"`);
}

export function toPrinting(value: string | undefined, fallback: Printing): Printing {
  const normalized = normalizeAlphanumeric(value ?? '');
  if (!normalized) return fallback;
  if (normalized.includes('reverseholo') || normalized === 'rh' || normalized === 'reverse') return 'Reverse';
  if (normalized.includes('1stedition') || normalized.includes('firstedition')) return 'FirstEdition';
  if (normalized.includes('holo')) return 'Holo';
  if (normalized.includes('foil') && !normalized.includes('non')) return 'Foil';
  // Some exports (for example Variance=Unlimited) mean a regular non-foil print.
  if (normalized.includes('unlimited')) return 'Normal';
  if (normalized.includes('nonfoil') || normalized.includes('normal') || normalized === 'regular') return 'Normal';
  throw new Error(`unrecognized printing "${value}"`);
}

export function toLanguage(value: string | undefined): Language {
  const normalized = normalizeAlphanumeric(value ?? '');
  if (!normalized) return 'EN';
  if (normalized.startsWith('en') || normalized === 'english') return 'EN';
  if (normalized.startsWith('jp') || normalized.startsWith('ja') || normalized.includes('japanese')) return 'JP';
  if (normalized.startsWith('de') || normalized.includes('german')) return 'DE';
  if (normalized.startsWith('fr') || normalized.includes('french')) return 'FR';
  if (normalized.startsWith('it') || normalized.includes('italian')) return 'IT';
  if (normalized.startsWith('es') || normalized.includes('spanish')) return 'ES';
  if (normalized.startsWith('pt') || normalized.includes('portuguese')) return 'PT';
  if (normalized.startsWith('ko') || normalized.includes('korean')) return 'KO';
  if (normalized.startsWith('cn') || normalized.startsWith('zh') || normalized.includes('chinese')) return 'CN';
  return 'EN';
}

export function toQty(value: string | undefined): number {
  if (!value) return 1;
  const parsed = parseInt(value.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function toCents(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const parsed = parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

export interface ImportRowDefaults {
  storeId: string;
  defaultCondition: Condition;
  defaultPrinting: Printing;
}

/**
 * Validates and coerces one raw CSV row. Throws when the row cannot be
 * imported (missing name, unrecognized condition/printing) so the caller can
 * record a per-row failure and continue with the rest of the file.
 */
export function validateImportRow(
  rowIndex: number,
  rawRow: ParsedCsvRow,
  defaults: ImportRowDefaults,
): ImportRecord {
  const row = mapRowToCanonicalColumns(rawRow);
  const readColumn = (column: string) => row[column]?.trim();

  const name = readColumn('name');
  if (!name) {
    throw new Error('missing name');
  }

  const game = toGame(readColumn('game'));
  const setName = readColumn('set') || null;
  const cardNumber = readColumn('cardNumber') || null;

  return {
    rowIndex,
    rawRow,
    game,
    name,
    setName,
    setCode: readColumn('setCode') || null,
    cardNumber,
    rarity: readColumn('rarity') || null,
    condition: toCondition(readColumn('condition'), defaults.defaultCondition),
    printing: toPrinting(readColumn('printing'), defaults.defaultPrinting),
    language: toLanguage(readColumn('language')),
    qty: toQty(readColumn('qty')),
    costCents: toCents(readColumn('costCents')),
    marketCents: toCents(readColumn('marketCents')),
    productKey: productIdentityKey({ storeId: defaults.storeId, game, name, setName, cardNumber }),
  };
}
