import { describe, expect, it } from 'vitest';
import { computeMargin, formatCostSummary, formatPriceSummary, summarizeInventoryValue } from './inventorySummaries';

describe('inventorySummaries', () => {
  it('formats missing, single, and range prices', () => {
    expect(formatPriceSummary({ minSellPriceCents: null, maxSellPriceCents: null, avgCostCents: null })).toBe('No price yet');
    expect(formatPriceSummary({ minSellPriceCents: 1234, maxSellPriceCents: 1234, avgCostCents: null })).toBe('$12.34');
    expect(formatPriceSummary({ minSellPriceCents: 100, maxSellPriceCents: 250, avgCostCents: null })).toBe('$1.00 - $2.50');
  });

  it('formats cost and margin summaries only when usable values exist', () => {
    expect(formatCostSummary({ minSellPriceCents: 1000, maxSellPriceCents: 1000, avgCostCents: 400 })).toBe('$4.00 / unit');
    expect(computeMargin({ minSellPriceCents: 1000, maxSellPriceCents: 1200, avgCostCents: 400 })).toEqual({
      percent: 66.66666666666666,
      profitCents: 800,
    });
    expect(computeMargin({ minSellPriceCents: 1000, maxSellPriceCents: null, avgCostCents: null })).toBeNull();
  });

  it('summarizes inventory value totals', () => {
    expect(summarizeInventoryValue({
      estimatedCostCents: 900,
      totalMarketValueCents: 1000,
      totalCostBasisCents: 700,
    })).toEqual({
      marketCents: 1000,
      costCents: 700,
      profitCents: 300,
      positive: true,
      marginPercent: 30,
    });
  });
});
