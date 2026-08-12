import { describe, expect, it } from 'vitest';
import {
  indexHeaders,
  mapRowToCanonicalColumns,
  normalizeHeaderName,
} from '../src/server/services/inventory-import/header-mapper';
import { toImportError, describeImportError } from '../src/server/services/inventory-import/import-error';
import {
  toCents,
  toCondition,
  toGame,
  toLanguage,
  toPrinting,
  toQty,
  validateImportRow,
} from '../src/server/services/inventory-import/row-validator';

describe('header mapper', () => {
  it('maps synonyms and dated market-price columns onto canonical names', () => {
    expect(normalizeHeaderName('Card Name')).toBe('name');
    expect(normalizeHeaderName('Average Cost Paid')).toBe('costCents');
    expect(normalizeHeaderName('Market Price As Of 2026-01-01')).toBe('marketCents');
    expect(normalizeHeaderName('Unknown Column')).toBeUndefined();
  });

  it('keeps the first header that claims a canonical name', () => {
    expect(indexHeaders(['Name', 'Price', 'Market Price'])).toEqual({ name: 0, marketCents: 1 });
  });

  it('rewrites a row so its keys are canonical names', () => {
    expect(mapRowToCanonicalColumns({ 'Card Name': 'Pikachu', Qty: '3', Notes: 'x' })).toEqual({
      name: 'Pikachu',
      qty: '3',
    });
  });
});

describe('row validator coercion', () => {
  it('recognizes game synonyms and falls back to other', () => {
    expect(toGame('Magic: The Gathering')).toBe('mtg');
    expect(toGame('Pokémon')).toBe('pokemon');
    expect(toGame(undefined)).toBe('other');
  });

  it('uses the fallback for blank condition and printing values', () => {
    expect(toCondition('', 'LP')).toBe('LP');
    expect(toCondition('Near Mint', 'LP')).toBe('NM');
    expect(() => toCondition('sparkly', 'NM')).toThrow(/unrecognized condition/);
    expect(toPrinting('', 'Foil')).toBe('Foil');
    expect(toPrinting('Reverse Holo', 'Normal')).toBe('Reverse');
    expect(() => toPrinting('shiny', 'Normal')).toThrow(/unrecognized printing/);
  });

  it('defaults language to EN and quantity to 1', () => {
    expect(toLanguage(undefined)).toBe('EN');
    expect(toLanguage('Japanese')).toBe('JP');
    expect(toQty('0')).toBe(1);
    expect(toQty('12 copies')).toBe(12);
  });

  it('parses currency-formatted prices into cents', () => {
    expect(toCents('$1,234.50')).toBe(123450);
    expect(toCents('')).toBeNull();
    expect(toCents('n/a')).toBeNull();
  });

  it('rejects a row without a name', () => {
    expect(() =>
      validateImportRow(0, { Set: 'Base' }, { storeId: 'store-1', defaultCondition: 'NM', defaultPrinting: 'Normal' }),
    ).toThrow(/missing name/);
  });

  it('builds a product identity key from store, game, name, set and number', () => {
    const record = validateImportRow(
      4,
      { Name: 'Pikachu', Set: 'Base', Number: '58', Game: 'Pokemon' },
      { storeId: 'store-1', defaultCondition: 'NM', defaultPrinting: 'Normal' },
    );
    expect(record.productKey).toBe('store-1|pokemon|Pikachu|Base|58');
    expect(record.rowIndex).toBe(4);
  });
});

describe('import error normalization', () => {
  it('extracts postgres fields from a nested cause chain exactly once', () => {
    const driverError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (id)=(1) already exists.',
      constraint: 'products_pkey',
    });
    const wrapped = Object.assign(new Error('insert failed'), { cause: driverError });

    const error = toImportError(wrapped);
    expect(error.message).toBe('insert failed');
    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('products_pkey');
    expect(describeImportError(error)).toBe(
      'insert failed | code=23505 | constraint=products_pkey | Key (id)=(1) already exists.',
    );
  });

  it('handles non-Error throwables and self-referencing causes', () => {
    expect(toImportError('boom').message).toBe('boom');

    const cyclic: Error & { cause?: unknown } = new Error('cyclic');
    cyclic.cause = cyclic;
    expect(toImportError(cyclic).message).toBe('cyclic');
  });
});
