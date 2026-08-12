export interface ProductPricingSummaryInput {
  minSellPriceCents: number | null;
  maxSellPriceCents: number | null;
  avgCostCents: number | null;
}

export interface InventorySummaryInput {
  estimatedCostCents: number;
  totalMarketValueCents?: number;
  totalCostBasisCents?: number;
}

export function formatPriceSummary(product: ProductPricingSummaryInput): string {
  if (product.minSellPriceCents == null && product.maxSellPriceCents == null) return 'No price yet';
  const min = product.minSellPriceCents ?? product.maxSellPriceCents;
  const max = product.maxSellPriceCents ?? product.minSellPriceCents;
  if (min == null || max == null) return 'No price yet';
  if (min === max) return `$${(min / 100).toFixed(2)}`;
  return `$${(min / 100).toFixed(2)} - $${(max / 100).toFixed(2)}`;
}

export function formatCostSummary(product: ProductPricingSummaryInput): string | null {
  if (!product.avgCostCents || product.avgCostCents <= 0) return null;
  return `$${(product.avgCostCents / 100).toFixed(2)} / unit`;
}

export function computeMargin(
  product: ProductPricingSummaryInput,
): { percent: number; profitCents: number } | null {
  const cost = product.avgCostCents;
  if (!cost || cost <= 0) return null;
  const market = product.maxSellPriceCents ?? product.minSellPriceCents;
  if (market == null || market <= 0) return null;
  const profit = market - cost;
  return { percent: (profit / market) * 100, profitCents: profit };
}

export function summarizeInventoryValue(summary: InventorySummaryInput) {
  const marketCents = summary.totalMarketValueCents ?? summary.estimatedCostCents ?? 0;
  const costCents = summary.totalCostBasisCents ?? 0;
  const profitCents = marketCents - costCents;
  return {
    marketCents,
    costCents,
    profitCents,
    positive: profitCents >= 0,
    marginPercent: costCents > 0 && marketCents > 0 ? (profitCents / marketCents) * 100 : null,
  };
}
