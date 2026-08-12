import type { CatalogSetSummary } from '@tcg/shared';
import { detectSet, normalizeSet } from './pokemonSets';

const NUMBER_QUERY_RE = /^(?=.*\d)[a-z0-9#\-\s]+(\s*\/\s*[a-z0-9#\-\s]+)?$/i;

export interface ResolvedTradeSearchParams {
  isCardNumberQuery: boolean;
  numberParam: string;
  nameParam: string;
  inferredSet: { id: string; name: string; start: number; length: number } | null;
  nameParamAfterSetStrip: string;
  effectiveNameParam: string;
  effectiveSetId: string;
  searchEnabled: boolean;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function inferSetFromQuery(
  nameParam: string,
  sets: CatalogSetSummary[],
): ResolvedTradeSearchParams['inferredSet'] {
  const canonical = detectSet(nameParam);
  if (canonical) {
    const target = normalizeSet(canonical.name);
    const pricedMatch = sets.find((set) => normalizeSet(set.name) === target);
    return {
      id: pricedMatch?.id ?? '',
      name: canonical.name,
      start: canonical.start,
      length: canonical.length,
    };
  }

  if (!sets.length) return null;
  const haystack = nameParam.toLowerCase();
  const queryTokens = new Set(tokenize(haystack));
  if (!queryTokens.size) return null;

  let bestTokenMatch: { id: string; name: string; start: number; length: number; score: number } | null = null;
  for (const set of sets) {
    const setTokens = tokenize(set.name);
    if (setTokens.length < 1) continue;
    if (!setTokens.every((token) => queryTokens.has(token))) continue;

    const score = setTokens.reduce((sum, token) => sum + token.length, 0);
    const firstToken = setTokens[0];
    const lastToken = setTokens[setTokens.length - 1];
    const start = haystack.indexOf(firstToken);
    const endIdx = haystack.lastIndexOf(lastToken);
    const length = endIdx >= 0 ? endIdx + lastToken.length - start : firstToken.length;

    if (!bestTokenMatch || score > bestTokenMatch.score) {
      bestTokenMatch = {
        id: set.id,
        name: set.name,
        start: Math.max(0, start),
        length: Math.max(firstToken.length, length),
        score,
      };
    }
  }

  return bestTokenMatch;
}

export function resolveTradeSearchParams(input: {
  active: boolean;
  normalizedQuery: string;
  selectedSetId: string;
  sets: CatalogSetSummary[];
  artistFilter: string;
}): ResolvedTradeSearchParams {
  const isCardNumberQuery = NUMBER_QUERY_RE.test(input.normalizedQuery);
  const numberParam = isCardNumberQuery ? input.normalizedQuery : '';
  const nameParam = isCardNumberQuery ? '' : input.normalizedQuery;
  const inferredSet =
    input.selectedSetId || isCardNumberQuery || !nameParam
      ? null
      : inferSetFromQuery(nameParam, input.sets);
  const nameParamAfterSetStrip = inferredSet
    ? (nameParam.slice(0, inferredSet.start) + nameParam.slice(inferredSet.start + inferredSet.length))
        .replace(/\s+/g, ' ')
        .trim()
    : nameParam;
  const effectiveNameParam = inferredSet ? nameParamAfterSetStrip : nameParam;
  const effectiveSetId = input.selectedSetId || inferredSet?.id || '';
  const searchEnabled =
    input.active &&
    !input.artistFilter &&
    (effectiveNameParam.length >= 2 || (!!numberParam && !!effectiveSetId) || !!effectiveSetId);

  return {
    isCardNumberQuery,
    numberParam,
    nameParam,
    inferredSet,
    nameParamAfterSetStrip,
    effectiveNameParam,
    effectiveSetId,
    searchEnabled,
  };
}
