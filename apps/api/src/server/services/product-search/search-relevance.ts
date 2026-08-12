/**
 * Pure text-similarity helpers used to guess which part of a free-text search
 * names a card set. Kept dependency-free so the ranking rules can be unit
 * tested without a database.
 */
import { normalizeToSpacedAlphanumeric } from '@tcg/shared';

/** Minimum trigram similarity before a set name is considered a fuzzy match. */
export const FUZZY_SET_MATCH_THRESHOLD = 0.42;

/** How close a runner-up must score to be reported as an ambiguous alternative. */
const AMBIGUITY_MARGIN = 0.02;

const MAX_AMBIGUOUS_CANDIDATES = 3;

function trigramSet(value: string): Set<string> {
  const padded = `  ${value}  `;
  const trigrams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    trigrams.add(padded.slice(i, i + 3));
  }
  return trigrams;
}

/** Dice coefficient over padded character trigrams; 0 when either side is empty. */
export function trigramSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const leftTrigrams = trigramSet(left);
  const rightTrigrams = trigramSet(right);
  if (leftTrigrams.size === 0 || rightTrigrams.size === 0) return 0;
  let overlap = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) overlap += 1;
  }
  return (2 * overlap) / (leftTrigrams.size + rightTrigrams.size);
}

/** Drops the first whole-word occurrence of `phrase` from `source`. */
export function removeFirstWholePhrase(source: string, phrase: string): string {
  if (!phrase) return source;
  const sourceWords = source.split(' ');
  const phraseWords = phrase.split(' ');
  if (phraseWords.length === 0 || sourceWords.length < phraseWords.length) return source;
  for (let start = 0; start <= sourceWords.length - phraseWords.length; start += 1) {
    const matches = phraseWords.every((word, offset) => sourceWords[start + offset] === word);
    if (matches) {
      return [...sourceWords.slice(0, start), ...sourceWords.slice(start + phraseWords.length)]
        .join(' ')
        .trim();
    }
  }
  return source;
}

/** Search synonyms for a single token (currently only the Mega/M card prefix). */
export function tokenVariants(token: string): string[] {
  const normalized = normalizeToSpacedAlphanumeric(token);
  if (!normalized) return [];
  if (normalized === 'mega') return ['mega', 'm'];
  if (normalized === 'm') return ['m', 'mega'];
  return [normalized];
}

export type SetInferenceStrategy = 'plain' | 'set_exact' | 'set_fuzzy';

export interface SetInference {
  strategy: SetInferenceStrategy;
  normalizedQuery: string;
  inferredSetName: string | null;
  inferredNameQuery: string;
  ambiguousSetCandidates: string[];
}

/**
 * Decides whether the query contains a set name, preferring an exact
 * whole-phrase hit (longest wins) and falling back to a trigram match.
 */
export function inferSetFromQuery(normalizedQuery: string, knownSetNames: string[]): SetInference {
  if (!normalizedQuery) {
    return {
      strategy: 'plain',
      normalizedQuery,
      inferredSetName: null,
      inferredNameQuery: '',
      ambiguousSetCandidates: [],
    };
  }

  const candidates = knownSetNames
    .filter((setName) => setName.trim().length > 0)
    .map((setName) => ({ original: setName, normalized: normalizeToSpacedAlphanumeric(setName) }))
    .filter((candidate) => candidate.normalized.length > 0);

  const exactHits = candidates
    .filter((candidate) => ` ${normalizedQuery} `.includes(` ${candidate.normalized} `))
    .sort((a, b) => b.normalized.length - a.normalized.length);

  const bestExact = exactHits[0];
  if (bestExact) {
    return {
      strategy: 'set_exact',
      normalizedQuery,
      inferredSetName: bestExact.original,
      inferredNameQuery: removeFirstWholePhrase(normalizedQuery, bestExact.normalized),
      ambiguousSetCandidates: exactHits
        .filter((candidate) => candidate.normalized.length === bestExact.normalized.length)
        .map((candidate) => candidate.original),
    };
  }

  const fuzzyHits = candidates
    .map((candidate) => ({
      ...candidate,
      score: trigramSimilarity(normalizedQuery, candidate.normalized),
    }))
    .sort((a, b) => b.score - a.score || b.normalized.length - a.normalized.length);

  const bestFuzzy = fuzzyHits[0];
  if (bestFuzzy && bestFuzzy.score >= FUZZY_SET_MATCH_THRESHOLD) {
    return {
      strategy: 'set_fuzzy',
      normalizedQuery,
      inferredSetName: bestFuzzy.original,
      inferredNameQuery: normalizedQuery,
      ambiguousSetCandidates: fuzzyHits
        .filter((candidate) => candidate.score >= bestFuzzy.score - AMBIGUITY_MARGIN)
        .slice(0, MAX_AMBIGUOUS_CANDIDATES)
        .map((candidate) => candidate.original),
    };
  }

  return {
    strategy: 'plain',
    normalizedQuery,
    inferredSetName: null,
    inferredNameQuery: normalizedQuery,
    ambiguousSetCandidates: [],
  };
}
