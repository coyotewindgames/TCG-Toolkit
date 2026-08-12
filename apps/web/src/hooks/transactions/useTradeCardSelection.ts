import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CatalogCard, CatalogPricesResponse } from '@tcg/shared';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';

export function useTradeCardSelection(active: boolean) {
  const [selectedCard, setSelectedCard] = useState<CatalogCard | null>(null);
  const selectedCardPricesQuery = useQuery<CatalogPricesResponse>({
    queryKey: queryKeys.trade.prices(selectedCard?.id),
    queryFn: ({ signal }) =>
      api.get<CatalogPricesResponse>(`/pkmnprices/cards/${encodeURIComponent(selectedCard!.id)}/prices`, { signal }),
    enabled: active && !!selectedCard?.id,
    staleTime: 5 * 60_000,
  });

  return {
    selectedCard,
    selectCard: setSelectedCard,
    selectedCardPrices: selectedCardPricesQuery.data?.prices ?? [],
    selectedCardPricesError: selectedCardPricesQuery.error,
  };
}
