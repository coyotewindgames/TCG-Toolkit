import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  CatalogArtistSearchResponse,
  CatalogCard,
  CatalogSearchResponse,
  CatalogSetsResponse,
} from '@tcg/shared';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { resolveTradeSearchParams } from '../../lib/tradeSearchParams';

function looksLikePersonName(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (/\d/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  return tokens.every((token) => /^[A-Za-z][A-Za-z'.-]{1,20}$/.test(token));
}

export function useTradeSearchQuery(input: {
  active: boolean;
  language: string;
  setId: string;
  normalizedQuery: string;
  rarityQuery: string;
  artistFilter: string;
}) {
  const setsQuery = useQuery<CatalogSetsResponse>({
    queryKey: queryKeys.trade.sets(input.language),
    queryFn: () => api.get<CatalogSetsResponse>(`/pkmnprices/sets?language=${encodeURIComponent(input.language)}`),
    enabled: input.active,
    staleTime: 24 * 60 * 60_000,
  });

  const params = resolveTradeSearchParams({
    active: input.active,
    normalizedQuery: input.normalizedQuery,
    selectedSetId: input.setId,
    sets: setsQuery.data?.sets ?? [],
    artistFilter: input.artistFilter,
  });

  const searchQuery = useQuery<CatalogSearchResponse>({
    queryKey: queryKeys.trade.search({
      query: params.effectiveNameParam,
      number: params.numberParam,
      language: input.language,
      setId: params.effectiveSetId,
      rarity: input.rarityQuery,
      perPage: 24,
    }),
    queryFn: ({ signal }) => {
      const urlParams = new URLSearchParams();
      if (params.effectiveNameParam) urlParams.set('q', params.effectiveNameParam);
      if (params.numberParam) urlParams.set('number', params.numberParam);
      if (input.language && input.language !== 'english') urlParams.set('language', input.language);
      if (params.effectiveSetId) urlParams.set('setId', params.effectiveSetId);
      urlParams.set('perPage', '24');
      return api.get<CatalogSearchResponse>(`/pkmnprices/search?${urlParams.toString()}`, { signal });
    },
    enabled: params.searchEnabled,
    staleTime: 60_000,
  });

  const shouldAutoFallbackArtist =
    !input.artistFilter &&
    params.searchEnabled &&
    !searchQuery.isFetching &&
    (searchQuery.data?.results.length ?? 0) === 0 &&
    looksLikePersonName(params.effectiveNameParam);
  const artistSearchTerm = input.artistFilter.trim() || (shouldAutoFallbackArtist ? params.effectiveNameParam : '');

  const artistSearchQuery = useQuery<CatalogArtistSearchResponse>({
    queryKey: queryKeys.trade.artistSearch(artistSearchTerm),
    queryFn: ({ signal }) => {
      const urlParams = new URLSearchParams();
      urlParams.set('name', artistSearchTerm);
      urlParams.set('perPage', '24');
      return api.get<CatalogArtistSearchResponse>(`/pkmncards/artist-search?${urlParams.toString()}`, { signal });
    },
    enabled: input.active && artistSearchTerm.length >= 2,
    staleTime: 5 * 60_000,
  });

  const searchResults = useMemo<CatalogCard[]>(() => {
    const primary = searchQuery.data?.results ?? [];
    const artist = artistSearchQuery.data?.results ?? [];
    const combined = input.artistFilter ? artist : primary.length > 0 ? primary : artist;
    const usable = combined.filter((card) => card.id);
    if (!input.rarityQuery) return usable;
    const needle = input.rarityQuery.toLowerCase();
    return usable.filter((card) => card.rarity?.toLowerCase().includes(needle));
  }, [searchQuery.data, artistSearchQuery.data, input.artistFilter, input.rarityQuery]);

  const rarityOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const card of searchQuery.data?.results ?? []) {
      if (card.rarity) seen.add(card.rarity);
    }
    return Array.from(seen).sort();
  }, [searchQuery.data]);

  return {
    sets: setsQuery.data?.sets ?? [],
    setsLoading: setsQuery.isLoading,
    searchEnabled: params.searchEnabled,
    searchResults,
    searchFetching: searchQuery.isFetching || artistSearchQuery.isFetching,
    searchError:
      (searchQuery.error ? (searchQuery.error as Error).message : null) ??
      (artistSearchQuery.error ? (artistSearchQuery.error as Error).message : null),
    isCardNumberQuery: params.isCardNumberQuery,
    inferredSetId: params.inferredSet?.id ?? null,
    inferredSetName: params.inferredSet?.name ?? null,
    matchedByArtist:
      !!input.artistFilter ||
      (artistSearchQuery.data?.resolvedArtist != null &&
        (artistSearchQuery.data?.results.length ?? 0) > 0 &&
        (searchQuery.data?.results.length ?? 0) === 0),
    resolvedArtistName: artistSearchQuery.data?.resolvedArtist?.displayName ?? null,
    rarityOptions,
  };
}
