import { describe, expect, it } from 'vitest';
import type { CatalogSetSummary } from '@tcg/shared';
import { resolveTradeSearchParams } from './tradeSearchParams';

const sets: CatalogSetSummary[] = [
  { id: 'swsh7', name: 'Evolving Skies' },
  { id: 'base1', name: 'Base Set' },
];

describe('resolveTradeSearchParams', () => {
  it('treats number-like queries as card numbers that require a set', () => {
    const result = resolveTradeSearchParams({
      active: true,
      normalizedQuery: '12/102',
      selectedSetId: '',
      sets,
      artistFilter: '',
    });

    expect(result.isCardNumberQuery).toBe(true);
    expect(result.numberParam).toBe('12/102');
    expect(result.effectiveNameParam).toBe('');
    expect(result.searchEnabled).toBe(false);
  });

  it('strips inferred set names from name searches', () => {
    const result = resolveTradeSearchParams({
      active: true,
      normalizedQuery: 'rayquaza evolving skies',
      selectedSetId: '',
      sets,
      artistFilter: '',
    });

    expect(result.inferredSet?.id).toBe('swsh7');
    expect(result.effectiveNameParam).toBe('rayquaza');
    expect(result.effectiveSetId).toBe('swsh7');
    expect(result.searchEnabled).toBe(true);
  });

  it('honors explicit set filters over inferred sets', () => {
    const result = resolveTradeSearchParams({
      active: true,
      normalizedQuery: 'charizard base set',
      selectedSetId: 'manual',
      sets,
      artistFilter: '',
    });

    expect(result.inferredSet).toBeNull();
    expect(result.effectiveNameParam).toBe('charizard base set');
    expect(result.effectiveSetId).toBe('manual');
  });
});
