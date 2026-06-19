import { describe, expect, it } from 'vitest';
import { computeSuggestedUnitValueCents } from '../src/server/services/tradeins';

describe('computeSuggestedUnitValueCents', () => {
  it('uses the lower of market and median as the base', () => {
    const value = computeSuggestedUnitValueCents({
      marketCents: 1000,
      medianCents: 800,
      condition: 'NM',
      payout: 'cash',
    });
    expect(value).toBe(560); // 800 * 0.70
  });

  it('applies store_credit multiplier higher than cash', () => {
    const args = { marketCents: 1000, medianCents: 1000, condition: 'NM' as const };
    const cash = computeSuggestedUnitValueCents({ ...args, payout: 'cash' });
    const credit = computeSuggestedUnitValueCents({ ...args, payout: 'store_credit' });
    expect(cash).toBe(700);
    expect(credit).toBe(800);
    expect(credit).toBeGreaterThan(cash);
  });

  it('returns zero when both signals are missing', () => {
    expect(
      computeSuggestedUnitValueCents({
        marketCents: null,
        medianCents: undefined,
        condition: 'NM',
        payout: 'cash',
      }),
    ).toBe(0);
  });

  it('does not change payout by condition', () => {
    const dmg = computeSuggestedUnitValueCents({
      marketCents: 1000,
      medianCents: 1000,
      condition: 'DMG',
      payout: 'cash',
    });
    expect(dmg).toBe(700); // 1000 * 0.70
  });

  it('floors fractional cents', () => {
    const value = computeSuggestedUnitValueCents({
      marketCents: 333,
      medianCents: 333,
      condition: 'NM',
      payout: 'cash',
    });
    expect(value).toBe(233); // 333 * 0.70 = 233.1 → 233
  });
});
