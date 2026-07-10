import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDebounced } from './useBarcodeScanner';

type ProductSort = 'name_asc' | 'price_desc' | 'price_asc';

interface UseProductSearchStateOptions {
  debounceMs?: number;
  rarityDebounceMs?: number;
  minQueryLength?: number;
  allowEmptyQuery?: boolean;
  defaultPageSize?: number;
  defaultSort?: ProductSort;
  includeParseDebug?: boolean;
  initialQuery?: string;
  initialGameFilter?: string;
  initialLanguageFilter?: string;
  initialSetFilter?: string;
  initialRarityFilter?: string;
  initialArtistFilter?: string;
}

interface BuildParamsOverrides {
  page?: number;
  pageSize?: number;
  sort?: ProductSort;
  includeParseDebug?: boolean;
}

export function useProductSearchState(options: UseProductSearchStateOptions = {}) {
  const {
    debounceMs = 300,
    rarityDebounceMs = debounceMs,
    minQueryLength = 2,
    allowEmptyQuery = false,
    defaultPageSize = 25,
    defaultSort = 'name_asc',
    includeParseDebug = false,
    initialQuery = '',
    initialGameFilter = '',
    initialLanguageFilter = '',
    initialSetFilter = '',
    initialRarityFilter = '',
    initialArtistFilter = '',
  } = options;

  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [sort, setSort] = useState<ProductSort>(defaultSort);
  const [gameFilter, setGameFilter] = useState(initialGameFilter);
  const [languageFilter, setLanguageFilter] = useState(initialLanguageFilter);
  const [setFilter, setSetFilter] = useState(initialSetFilter);
  const [rarityFilter, setRarityFilter] = useState(initialRarityFilter);
  const [artistFilter, setArtistFilter] = useState(initialArtistFilter);

  const debouncedQuery = useDebounced(query, debounceMs);
  const trimmedDebouncedQuery = debouncedQuery.trim();
  const debouncedRarityFilter = useDebounced(rarityFilter, rarityDebounceMs);
  const trimmedDebouncedRarityFilter = debouncedRarityFilter.trim();

  useEffect(() => {
    setPage(1);
  }, [trimmedDebouncedQuery, sort, gameFilter, languageFilter, setFilter, rarityFilter, artistFilter]);

  const isEnabled = useMemo(
    () =>
      (allowEmptyQuery && trimmedDebouncedQuery.length === 0) ||
      trimmedDebouncedQuery.length >= minQueryLength,
    [allowEmptyQuery, minQueryLength, trimmedDebouncedQuery],
  );

  const buildParams = useCallback((overrides: BuildParamsOverrides = {}) => {
    const params = new URLSearchParams();

    params.set('q', trimmedDebouncedQuery);
    params.set('page', String(overrides.page ?? page));
    params.set('pageSize', String(overrides.pageSize ?? pageSize));
    params.set('sort', overrides.sort ?? sort);

    if (gameFilter) params.set('game', gameFilter);
    if (languageFilter) params.set('language', languageFilter);
    if (setFilter) params.set('set', setFilter);
    if (rarityFilter) params.set('rarity', rarityFilter);
    if (artistFilter) params.set('artist', artistFilter);

    const useParseDebug = overrides.includeParseDebug ?? includeParseDebug;
    if (useParseDebug) params.set('includeParseDebug', '1');

    return params;
  }, [
    trimmedDebouncedQuery,
    page,
    pageSize,
    sort,
    gameFilter,
    languageFilter,
    setFilter,
    rarityFilter,
    artistFilter,
    includeParseDebug,
  ]);

  return {
    query,
    setQuery,
    debouncedQuery,
    trimmedDebouncedQuery,
    debouncedRarityFilter,
    trimmedDebouncedRarityFilter,
    page,
    setPage,
    pageSize,
    setPageSize,
    sort,
    setSort,
    gameFilter,
    setGameFilter,
    languageFilter,
    setLanguageFilter,
    setFilter,
    setSetFilter,
    rarityFilter,
    setRarityFilter,
    artistFilter,
    setArtistFilter,
    isEnabled,
    buildParams,
  };
}
