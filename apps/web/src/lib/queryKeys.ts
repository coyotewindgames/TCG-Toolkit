import { pkmnPricesSearchQueryKey, productsSearchQueryKey } from './searchQueryKeys';

export const queryKeys = {
  products: {
    search: productsSearchQueryKey,
    skus: (productId: string | null | undefined, scope = 'products') =>
      ['products', 'skus', scope, productId ?? null] as const,
  },
  inventory: {
    summary: () => ['inventory', 'summary'] as const,
  },
  trade: {
    sets: (language: string) => ['transactions', 'trade', 'sets', 'v2', language] as const,
    search: pkmnPricesSearchQueryKey,
    artistSearch: (term: string) => ['transactions', 'trade', 'artistSearch', term] as const,
    prices: (cardId: string | null | undefined) => ['transactions', 'trade', 'prices', cardId ?? null] as const,
  },
  sell: {
    search: (query: string) => ['transactions', 'sell', 'search', query.trim()] as const,
    skus: (productId: string | null | undefined) => ['transactions', 'sell', 'skus', productId ?? null] as const,
  },
  history: {
    trades: (page: number, pageSize: number, status: string) =>
      ['history', 'trades', page, pageSize, status] as const,
  },
} as const;

export { pkmnPricesSearchQueryKey, productsSearchQueryKey };
