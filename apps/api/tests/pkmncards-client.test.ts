import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PkmnCardsClient } from '../src/integrations/pkmncards/client';

describe('PkmnCardsClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns deterministic URL when generated image exists', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new PkmnCardsClient();
    const result = await client.lookup({
      name: 'Bulbasaur',
      setCode: 'ME4',
      setName: 'Mega Evolution',
      cardNumber: '116',
    });

    expect(result).toEqual({
      imageUrl: 'https://pkmncards.com/wp-content/uploads/me4_en_116_std.jpg',
      cardUrl: null,
      method: 'deterministic',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pkmncards.com/wp-content/uploads/me4_en_116_std.jpg',
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('falls back to search and card-page image extraction when deterministic lookup is unavailable', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://pkmncards.com/?')) {
        return new Response(
          '<a href="https://pkmncards.com/card/bulbasaur-mega-evolution-meg-001/">Bulbasaur</a>',
          { status: 200 },
        );
      }

      if (url === 'https://pkmncards.com/card/bulbasaur-mega-evolution-meg-001/') {
        return new Response(
          '<a href="https://pkmncards.com/wp-content/uploads/me1_en_001_std.jpg">jpg</a>',
          { status: 200 },
        );
      }

      return new Response('', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = new PkmnCardsClient();
    const result = await client.lookup({
      name: 'Bulbasaur',
      setCode: null,
      setName: null,
      cardNumber: null,
    });

    expect(result).toEqual({
      imageUrl: 'https://pkmncards.com/wp-content/uploads/me1_en_001_std.jpg',
      cardUrl: 'https://pkmncards.com/card/bulbasaur-mega-evolution-meg-001/',
      method: 'search',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
