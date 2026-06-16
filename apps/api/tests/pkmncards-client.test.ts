import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PkmnCardsClient } from '../src/integrations/pkmncards/client';

describe('PkmnCardsClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns deterministic URL when generated image exists', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://pkmncards.com/sets/') {
        return new Response('<a href="https://pkmncards.com/set/chaos-rising/">Chaos Rising (CRI)</a>', {
          status: 200,
        });
      }
      return new Response('', { status: 200 });
    });
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pkmncards.com/wp-content/uploads/me4_en_116_std.jpg',
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('falls back to search and card-page image extraction when deterministic lookup is unavailable', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://pkmncards.com/sets/') {
        return new Response('', { status: 200 });
      }

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
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('infers card number from name suffix for deterministic lookup', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://pkmncards.com/sets/') return new Response('', { status: 200 });
      if (url.endsWith('/me1_en_62_std.jpg')) return new Response('', { status: 404 });
      if (url.endsWith('/me1_en_062_std.jpg')) return new Response('', { status: 200 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new PkmnCardsClient();
    const result = await client.lookup({
      name: 'Mewtwo EX (62)',
      setCode: 'ME1',
      setName: 'Mega Evolution',
      cardNumber: null,
    });

    expect(result).toEqual({
      imageUrl: 'https://pkmncards.com/wp-content/uploads/me1_en_062_std.jpg',
      cardUrl: null,
      method: 'deterministic',
    });
  });

  it('uses plain text name query when structured search tokens miss', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://pkmncards.com/sets/') {
        return new Response('', { status: 200 });
      }

      if (url.startsWith('https://pkmncards.com/?')) {
        // Simulate production behavior: `name:slug` and quoted forms miss,
        // but plain text search returns card links.
        if (url.includes('name%3Azacian-v') || url.includes('s=%22Zacian+V%22')) {
          return new Response('<div>no card links here</div>', { status: 200 });
        }
        if (url.includes('s=Zacian+V')) {
          return new Response(
            '<a href="https://pkmncards.com/card/zacian-sword-shield-ssh-138/">Zacian</a>',
            { status: 200 },
          );
        }
        return new Response('', { status: 200 });
      }

      if (url === 'https://pkmncards.com/card/zacian-sword-shield-ssh-138/') {
        return new Response(
          '<a href="https://pkmncards.com/wp-content/uploads/ssh_en_138_std.jpg">img</a>',
          { status: 200 },
        );
      }

      return new Response('', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = new PkmnCardsClient();
    const result = await client.lookup({
      name: 'Zacian V',
      setCode: null,
      setName: null,
      cardNumber: null,
    });

    expect(result).toEqual({
      imageUrl: 'https://pkmncards.com/wp-content/uploads/ssh_en_138_std.jpg',
      cardUrl: 'https://pkmncards.com/card/zacian-sword-shield-ssh-138/',
      method: 'search',
    });
  });

  it('accepts canonical non-_std card images from card pages', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://pkmncards.com/sets/') {
        return new Response('', { status: 200 });
      }

      if (url.startsWith('https://pkmncards.com/?')) {
        return new Response(
          '<a href="https://pkmncards.com/card/zacian-v-crown-zenith-crz-095/">Zacian V</a>',
          { status: 200 },
        );
      }

      if (url === 'https://pkmncards.com/card/zacian-v-crown-zenith-crz-095/') {
        return new Response(
          '<a href="https://pkmncards.com/wp-content/uploads/en_US-CZ-095-zacian_v.jpg">jpg</a>',
          { status: 200 },
        );
      }

      return new Response('', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = new PkmnCardsClient();
    const result = await client.lookup({
      name: 'Zacian V',
      setCode: null,
      setName: null,
      cardNumber: null,
    });

    expect(result).toEqual({
      imageUrl: 'https://pkmncards.com/wp-content/uploads/en_US-CZ-095-zacian_v.jpg',
      cardUrl: 'https://pkmncards.com/card/zacian-v-crown-zenith-crz-095/',
      method: 'search',
    });
  });
});
