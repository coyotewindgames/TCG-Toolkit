import { useMemo, useState } from 'react';
import type { CardCondition, CardLanguage, CardPrinting } from '@tcg/shared';

export interface TradeQueueItem {
  id: string;
  tcgapiProductId: string;
  name: string;
  imageSourceUrl: string | null;
  rarity: string | null;
  condition: CardCondition;
  printing: CardPrinting;
  language: CardLanguage;
  quantity: number;
  payoutModifierPercent: number;
  overrideValueCents?: number;
  marketPriceCents: number | null;
  estimatedUnitValueCents: number;
}

function sameQueueIdentity(a: TradeQueueItem, b: TradeQueueItem): boolean {
  return (
    a.tcgapiProductId === b.tcgapiProductId &&
    a.condition === b.condition &&
    a.printing === b.printing &&
    a.language === b.language &&
    a.payoutModifierPercent === b.payoutModifierPercent &&
    (a.overrideValueCents ?? null) === (b.overrideValueCents ?? null)
  );
}

export interface TradeQueueStateController {
  items: TradeQueueItem[];
  totalCents: number;
  cardCount: number;
  addItem: (item: TradeQueueItem) => void;
  removeItem: (id: string) => void;
  clear: () => void;
}

export function useTradeQueueState(): TradeQueueStateController {
  const [items, setItems] = useState<TradeQueueItem[]>([]);

  const totalCents = useMemo(
    () => items.reduce((sum, item) => sum + item.estimatedUnitValueCents * item.quantity, 0),
    [items],
  );

  const cardCount = useMemo(
    () => items.reduce((sum, item) => sum + item.quantity, 0),
    [items],
  );

  function addItem(next: TradeQueueItem) {
    setItems((previous) => {
      const existingIdx = previous.findIndex((item) => sameQueueIdentity(item, next));
      if (existingIdx === -1) return [...previous, next];
      return previous.map((item, idx) =>
        idx === existingIdx ? { ...item, quantity: item.quantity + next.quantity } : item,
      );
    });
  }

  function removeItem(id: string) {
    setItems((previous) => previous.filter((item) => item.id !== id));
  }

  function clear() {
    setItems([]);
  }

  return {
    items,
    totalCents,
    cardCount,
    addItem,
    removeItem,
    clear,
  };
}
