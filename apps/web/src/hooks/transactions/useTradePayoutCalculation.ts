import { useMemo, useState } from 'react';
import type { CardCondition, CardLanguage, CardPrinting, CatalogPriceRow, PayoutKind } from '@tcg/shared';
import { TRADE_PAYOUT_MULTIPLIERS } from '@tcg/shared';

export function tcgapiPrintingToEnum(label: string): CardPrinting {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return 'Normal';
  if (normalized.includes('reverseholo') || normalized === 'reverse' || normalized === 'rh') return 'Reverse';
  if (normalized.includes('1stedition') || normalized.includes('firstedition')) return 'FirstEdition';
  if (normalized.includes('holo')) return 'Holo';
  if (normalized.includes('foil') && !normalized.includes('non')) return 'Foil';
  return 'Normal';
}

export function pickPricingRow(prices: CatalogPriceRow[] | undefined, printing: CardPrinting): CatalogPriceRow | undefined {
  if (!prices?.length) return undefined;
  return (
    prices.find((row) => tcgapiPrintingToEnum(row.printing) === printing) ??
    prices.find((row) => (row.marketCents ?? 0) > 0) ??
    prices[0]
  );
}

export function suggestedUnitValueCents(
  prices: CatalogPriceRow[] | undefined,
  printing: CardPrinting,
  payout: PayoutKind,
  payoutModifierPercent: number,
): number {
  const row = pickPricingRow(prices, printing);
  if (!row) return 0;
  const candidates = [row.marketCents, row.medianCents].filter(
    (value): value is number => typeof value === 'number' && value > 0,
  );
  const base = candidates.length ? Math.min(...candidates) : 0;
  const payoutBase = Math.max(0, Math.floor(base * TRADE_PAYOUT_MULTIPLIERS[payout]));
  return Math.max(0, Math.floor(payoutBase * (1 + payoutModifierPercent / 100)));
}

export function useTradePayoutCalculation(prices: CatalogPriceRow[]) {
  const [condition, setCondition] = useState<CardCondition>('NM');
  const [printing, setPrinting] = useState<CardPrinting>('Normal');
  const [cardLanguage, setCardLanguage] = useState<CardLanguage>('EN');
  const [quantity, setQuantity] = useState<number>(1);
  const [payout, setPayout] = useState<PayoutKind>('cash');
  const [payoutModifierPercent, setPayoutModifierPercent] = useState<string>('0');
  const [overrideValue, setOverrideValue] = useState<string>('');

  const payoutModifier = useMemo(() => {
    const value = Number(payoutModifierPercent);
    return Number.isFinite(value) ? value : 0;
  }, [payoutModifierPercent]);

  const overrideCents = useMemo(() => {
    const value = overrideValue.trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed * 100);
  }, [overrideValue]);

  const suggestedTradeUnitCents = useMemo(
    () => suggestedUnitValueCents(prices, printing, payout, payoutModifier),
    [prices, printing, payout, payoutModifier],
  );

  const selectedMarketPriceCents = useMemo(() => {
    const row = pickPricingRow(prices, printing);
    return row?.marketCents ?? null;
  }, [prices, printing]);

  const pendingLineTotalCents = (overrideCents ?? suggestedTradeUnitCents) * quantity;

  return {
    condition,
    setCondition,
    printing,
    setPrinting,
    cardLanguage,
    setCardLanguage,
    quantity,
    setQuantity,
    payout,
    setPayout,
    payoutModifierPercent,
    setPayoutModifierPercent,
    overrideValue,
    setOverrideValue,
    payoutModifier,
    overrideCents,
    suggestedTradeUnitCents,
    selectedMarketPriceCents,
    pendingLineTotalCents,
  };
}
