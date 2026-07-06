/* @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTradeQueueState, type TradeQueueItem } from './useTradeQueueState';

function makeItem(overrides: Partial<TradeQueueItem> = {}): TradeQueueItem {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tcgapiProductId: overrides.tcgapiProductId ?? 'card-1',
    name: overrides.name ?? 'Card A',
    imageSourceUrl: overrides.imageSourceUrl ?? null,
    rarity: overrides.rarity ?? 'Rare',
    condition: overrides.condition ?? 'NM',
    printing: overrides.printing ?? 'Normal',
    language: overrides.language ?? 'EN',
    quantity: overrides.quantity ?? 1,
    payoutModifierPercent: overrides.payoutModifierPercent ?? 0,
    overrideValueCents: overrides.overrideValueCents,
    marketPriceCents: overrides.marketPriceCents ?? 1000,
    estimatedUnitValueCents: overrides.estimatedUnitValueCents ?? 700,
  };
}

describe('useTradeQueueState', () => {
  it('adds items and merges identical queue identities', () => {
    const { result } = renderHook(() => useTradeQueueState());

    act(() => {
      result.current.addItem(makeItem({ id: '1', quantity: 1 }));
      result.current.addItem(makeItem({ id: '2', quantity: 2 }));
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.quantity).toBe(3);
    expect(result.current.cardCount).toBe(3);
    expect(result.current.totalCents).toBe(3 * 700);
  });

  it('keeps distinct entries when queue identity differs', () => {
    const { result } = renderHook(() => useTradeQueueState());

    act(() => {
      result.current.addItem(makeItem({ id: '1', printing: 'Normal' }));
      result.current.addItem(makeItem({ id: '2', printing: 'Foil' }));
    });

    expect(result.current.items).toHaveLength(2);
    expect(result.current.cardCount).toBe(2);
  });

  it('removes items and clears queue state', () => {
    const { result } = renderHook(() => useTradeQueueState());

    act(() => {
      result.current.addItem(makeItem({ id: '1', quantity: 2 }));
      result.current.addItem(makeItem({ id: '2', printing: 'Foil', quantity: 1 }));
    });

    act(() => {
      result.current.removeItem('1');
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.id).toBe('2');

    act(() => {
      result.current.clear();
    });

    expect(result.current.items).toHaveLength(0);
    expect(result.current.cardCount).toBe(0);
    expect(result.current.totalCents).toBe(0);
  });
});
