import { useQuery } from '@tanstack/react-query';
import type { CardGradingCompany } from '@tcg/shared';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';

export interface TradeGradedSale {
  priceCents: number;
  soldAt: string;
  title: string;
  listingUrl: string;
}

/** Response from GET /pkmnprices/cards/:id/graded-price — a live median
 * pulled from recent eBay sold comps for one (grading company, grade). */
export interface TradeGradedPriceResponse {
  cardId: string;
  company: string;
  grade: string;
  medianCents: number | null;
  sampleSize: number;
  sales: TradeGradedSale[];
}

/**
 * Fetches a live graded-slab median for the selected card once the operator
 * opts into "Graded card" and picks a company + grade. Not fetched eagerly:
 * the upstream endpoint costs 1 credit per eBay sale returned.
 */
export function useTradeGradedPrice(params: {
  cardId: string | undefined;
  active: boolean;
  isGraded: boolean;
  company: CardGradingCompany;
  grade: string;
}) {
  const { cardId, active, isGraded, company, grade } = params;
  return useQuery<TradeGradedPriceResponse>({
    queryKey: queryKeys.trade.gradedPrice(cardId, company, grade),
    queryFn: ({ signal }) =>
      api.get<TradeGradedPriceResponse>(
        `/pkmnprices/cards/${encodeURIComponent(cardId!)}/graded-price?company=${encodeURIComponent(company)}&grade=${encodeURIComponent(grade)}`,
        { signal },
      ),
    enabled: active && isGraded && !!cardId && !!grade,
    staleTime: 30 * 60_000,
    retry: false,
  });
}
