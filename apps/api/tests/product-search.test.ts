import { describe, expect, it } from 'vitest';
import {
  inferSetFromQuery,
  removeFirstWholePhrase,
  tokenVariants,
  trigramSimilarity,
} from '../src/server/services/product-search/search-relevance';
import {
  parseProductSearchQuery,
  resolveSearchFilters,
} from '../src/server/services/product-search/search-query-parser';

describe('search relevance', () => {
  it('scores identical strings 1 and disjoint strings low', () => {
    expect(trigramSimilarity('base set', 'base set')).toBe(1);
    expect(trigramSimilarity('base set', '')).toBe(0);
    expect(trigramSimilarity('base set', 'zzzzzz')).toBeLessThan(0.2);
  });

  it('removes only the first whole-word occurrence of a phrase', () => {
    expect(removeFirstWholePhrase('charizard base set', 'base set')).toBe('charizard');
    expect(removeFirstWholePhrase('basement charizard', 'base')).toBe('basement charizard');
  });

  it('treats mega and m as interchangeable tokens', () => {
    expect(tokenVariants('Mega')).toEqual(['mega', 'm']);
    expect(tokenVariants('m')).toEqual(['m', 'mega']);
    expect(tokenVariants('charizard')).toEqual(['charizard']);
  });
});

describe('set inference', () => {
  const sets = ['Base Set', 'Base Set 2', 'Evolving Skies'];

  it('prefers the longest exact set phrase and strips it from the name query', () => {
    const inference = inferSetFromQuery('charizard base set 2', sets);
    expect(inference.strategy).toBe('set_exact');
    expect(inference.inferredSetName).toBe('Base Set 2');
    expect(inference.inferredNameQuery).toBe('charizard');
  });

  it('falls back to a fuzzy match and keeps the full name query', () => {
    const inference = inferSetFromQuery('evolving skys', sets);
    expect(inference.strategy).toBe('set_fuzzy');
    expect(inference.inferredSetName).toBe('Evolving Skies');
    expect(inference.inferredNameQuery).toBe('evolving skys');
  });

  it('reports no set when nothing is close enough', () => {
    const inference = inferSetFromQuery('pikachu', sets);
    expect(inference.strategy).toBe('plain');
    expect(inference.inferredSetName).toBeNull();
  });

  it('returns an empty plain inference for a blank query', () => {
    expect(inferSetFromQuery('', sets)).toEqual({
      strategy: 'plain',
      normalizedQuery: '',
      inferredSetName: null,
      inferredNameQuery: '',
      ambiguousSetCandidates: [],
    });
  });
});

describe('product search query parsing', () => {
  it('clamps page size and derives the offset', () => {
    expect(parseProductSearchQuery({ query: ' pikachu ', page: 3, pageSize: 500 })).toMatchObject({
      rawQuery: 'pikachu',
      page: 3,
      pageSize: 100,
      offset: 200,
      sort: 'name_asc',
    });
    expect(parseProductSearchQuery({ query: '', pageSize: 1 }).pageSize).toBe(10);
    expect(parseProductSearchQuery({ query: '' }).pageSize).toBe(25);
  });

  it('lets an explicit set filter override the inferred one and records the conflict', () => {
    const query = parseProductSearchQuery({ query: 'charizard base set', setName: 'Evolving Skies' });
    const resolved = resolveSearchFilters(query, {
      strategy: 'set_exact',
      normalizedQuery: 'charizard base set',
      inferredSetName: 'Base Set',
      inferredNameQuery: 'charizard',
      ambiguousSetCandidates: [],
    });

    expect(resolved.effectiveSetFilter).toBe('Evolving Skies');
    expect(resolved.effectiveNameQuery).toBe('charizard');
    expect(resolved.normalizedTokens).toEqual(['charizard']);
    expect(resolved.conflictNotes).toEqual(['explicit set filter overrides inferred set']);
  });

  it('falls back to the raw query when nothing was inferred', () => {
    const query = parseProductSearchQuery({ query: 'pikachu' });
    const resolved = resolveSearchFilters(query, {
      strategy: 'plain',
      normalizedQuery: 'pikachu',
      inferredSetName: null,
      inferredNameQuery: '',
      ambiguousSetCandidates: [],
    });
    expect(resolved.effectiveSetFilter).toBe('');
    expect(resolved.effectiveNameQuery).toBe('pikachu');
    expect(resolved.conflictNotes).toEqual([]);
  });
});
