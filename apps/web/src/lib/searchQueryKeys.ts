type ProductSort = 'name_asc' | 'price_desc' | 'price_asc';

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

interface ProductsSearchKeyInput {
  query: string;
  page: number;
  pageSize: number;
  sort: ProductSort;
  game?: string;
  language?: string;
  setName?: string;
  rarity?: string;
  includeParseDebug?: boolean;
}

export function productsSearchQueryKey(scope: 'inventory' | 'register', input: ProductsSearchKeyInput) {
  return [
    'search',
    'products',
    scope,
    {
      query: clean(input.query),
      page: input.page,
      pageSize: input.pageSize,
      sort: input.sort,
      game: clean(input.game),
      language: clean(input.language),
      setName: clean(input.setName),
      rarity: clean(input.rarity),
      includeParseDebug: !!input.includeParseDebug,
    },
  ] as const;
}

interface PkmnPricesSearchKeyInput {
  query: string;
  number: string;
  language: string;
  setId?: string;
  rarity: string;
  perPage: number;
}

export function pkmnPricesSearchQueryKey(input: PkmnPricesSearchKeyInput) {
  return [
    'search',
    'pkmnprices',
    {
      query: clean(input.query),
      number: clean(input.number),
      language: clean(input.language),
      setId: clean(input.setId),
      rarity: clean(input.rarity),
      perPage: input.perPage,
    },
  ] as const;
}
