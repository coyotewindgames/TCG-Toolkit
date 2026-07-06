import { describe, expect, it } from 'vitest';
import { pkmnPricesSearchQueryKey, productsSearchQueryKey } from './searchQueryKeys';

describe('searchQueryKeys', () => {
  it('normalizes equivalent products search inputs to the same key', () => {
    const keyA = productsSearchQueryKey('inventory', {
      query: '  pikachu  ',
      page: 1,
      pageSize: 25,
      sort: 'name_asc',
      game: ' pokemon ',
      language: ' EN ',
      setName: ' base set ',
      rarity: ' rare ',
      includeParseDebug: true,
    });

    const keyB = productsSearchQueryKey('inventory', {
      query: 'pikachu',
      page: 1,
      pageSize: 25,
      sort: 'name_asc',
      game: 'pokemon',
      language: 'EN',
      setName: 'base set',
      rarity: 'rare',
      includeParseDebug: true,
    });

    expect(keyA).toEqual(keyB);
  });

  it('separates products keys by page scope and pagination', () => {
    const registerKey = productsSearchQueryKey('register', {
      query: 'pikachu',
      page: 1,
      pageSize: 8,
      sort: 'name_asc',
    });

    const inventoryKey = productsSearchQueryKey('inventory', {
      query: 'pikachu',
      page: 1,
      pageSize: 25,
      sort: 'name_asc',
    });

    expect(registerKey).not.toEqual(inventoryKey);
  });

  it('normalizes equivalent pkmnprices search inputs to the same key', () => {
    const keyA = pkmnPricesSearchQueryKey({
      query: '  charizard ',
      number: '  ',
      language: ' english ',
      setId: ' 123 ',
      rarity: ' holo ',
      perPage: 24,
    });

    const keyB = pkmnPricesSearchQueryKey({
      query: 'charizard',
      number: '',
      language: 'english',
      setId: '123',
      rarity: 'holo',
      perPage: 24,
    });

    expect(keyA).toEqual(keyB);
  });
});
