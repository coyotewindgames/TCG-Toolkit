import { useQuery } from '@tanstack/react-query';
import type { ProductSearchResponse } from '@tcg/shared';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';

type ProductSort = 'name_asc' | 'price_desc' | 'price_asc';

interface UseInventorySearchInput {
  scope: 'inventory' | 'register';
  query: string;
  page: number;
  pageSize: number;
  sort: ProductSort;
  enabled: boolean;
  buildParams: () => URLSearchParams;
  game?: string;
  language?: string;
  setName?: string;
  rarity?: string;
  artist?: string;
  includeParseDebug?: boolean;
}

export function useInventorySearch<TResponse = ProductSearchResponse>(input: UseInventorySearchInput) {
  return useQuery<TResponse>({
    queryKey: queryKeys.products.search(input.scope, {
      query: input.query,
      page: input.page,
      pageSize: input.pageSize,
      sort: input.sort,
      game: input.game,
      language: input.language,
      setName: input.setName,
      rarity: input.rarity,
      artist: input.artist,
      includeParseDebug: input.includeParseDebug,
    }),
    queryFn: ({ signal }) => api.get<TResponse>(`/products/search?${input.buildParams().toString()}`, { signal }),
    enabled: input.enabled,
    placeholderData: (prev) => prev,
  });
}
