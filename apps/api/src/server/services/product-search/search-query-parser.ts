/**
 * Turns the raw query-string arguments of an inventory search into a
 * normalized, fully-defaulted description of what to query. Pure, so the
 * pagination clamps and filter precedence rules are unit testable.
 */
import { normalizeToSpacedAlphanumeric } from '@tcg/shared';
import type { SetInference } from './search-relevance';

export type ProductSort = 'name_asc' | 'price_desc' | 'price_asc';

export interface ProductSearchArgs {
  query: string;
  page?: number;
  pageSize?: number;
  sort?: ProductSort;
  setName?: string;
  rarity?: string;
  game?: string;
  language?: string;
  artist?: string;
  includeParseDebug?: boolean;
}

export interface ProductSearchQuery {
  rawQuery: string;
  page: number;
  pageSize: number;
  offset: number;
  sort: ProductSort;
  explicitSetFilter: string;
  rarityFilter: string;
  gameFilter: string;
  languageFilter: string;
  artistFilter: string;
  includeParseDebug: boolean;
}

const DEFAULT_PAGE_SIZE = 25;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

export function parseProductSearchQuery(args: ProductSearchArgs): ProductSearchQuery {
  const page = Number.isFinite(args.page) ? Math.max(1, Number(args.page)) : 1;
  const requestedPageSize = Number.isFinite(args.pageSize) ? Number(args.pageSize) : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, requestedPageSize));

  return {
    rawQuery: args.query.trim(),
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sort: args.sort ?? 'name_asc',
    explicitSetFilter: args.setName?.trim() ?? '',
    rarityFilter: args.rarity?.trim() ?? '',
    gameFilter: args.game?.trim() ?? '',
    languageFilter: args.language?.trim() ?? '',
    artistFilter: args.artist?.trim() ?? '',
    includeParseDebug: !!args.includeParseDebug,
  };
}

export interface ResolvedSearchFilters {
  effectiveSetFilter: string;
  effectiveNameQuery: string;
  normalizedTokens: string[];
  conflictNotes: string[];
}

/**
 * Combines the caller's explicit filters with what was inferred from the query
 * text. An explicit set filter always wins; the conflict is reported so the
 * debug view can explain why the inferred set was ignored.
 */
export function resolveSearchFilters(
  query: ProductSearchQuery,
  inference: SetInference,
): ResolvedSearchFilters {
  const inferredSetFilter = query.explicitSetFilter ? '' : inference.inferredSetName ?? '';
  const effectiveNameQuery = (inference.inferredNameQuery || query.rawQuery).trim();

  const conflictNotes: string[] = [];
  if (
    query.explicitSetFilter &&
    inference.inferredSetName &&
    query.explicitSetFilter !== inference.inferredSetName
  ) {
    conflictNotes.push('explicit set filter overrides inferred set');
  }

  return {
    effectiveSetFilter: query.explicitSetFilter || inferredSetFilter,
    effectiveNameQuery,
    normalizedTokens: normalizeToSpacedAlphanumeric(effectiveNameQuery)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
    conflictNotes,
  };
}
