/**
 * Unit coverage for the pure card-URL parser. Fuzzy resolveArtistSlug is
 * exercised via integration since it requires network fetches; here we lock
 * down the URL parsing that hydration downstream depends on.
 */
import { describe, expect, it } from 'vitest';
import { parseCardUrl } from '../src/integrations/pkmncards/client';

describe('parseCardUrl', () => {
  it('parses a standard modern card URL', () => {
    const parsed = parseCardUrl('https://pkmncards.com/card/aipom-paradox-rift-par-211/');
    expect(parsed).toEqual({
      cardUrl: 'https://pkmncards.com/card/aipom-paradox-rift-par-211/',
      nameSlug: 'aipom-paradox-rift',
      setSlug: null,
      setCode: 'par',
      number: '211',
    });
  });

  it('parses a legacy card URL with dashed set slug', () => {
    const parsed = parseCardUrl('/card/aarons-collection-rising-rivals-rr-88/');
    expect(parsed?.setCode).toBe('rr');
    expect(parsed?.number).toBe('88');
  });

  it('accepts alphanumeric card numbers (e.g. TG01, H1)', () => {
    const parsed = parseCardUrl('https://pkmncards.com/card/pikachu-hidden-fates-shiny-vault-sv-sv1/');
    expect(parsed?.number).toBe('sv1');
    expect(parsed?.setCode).toBe('sv');
  });

  it('returns null for URLs without a /card/ segment', () => {
    expect(parseCardUrl('https://pkmncards.com/artist/ken-sugimori/')).toBeNull();
    expect(parseCardUrl('')).toBeNull();
  });

  it('is tolerant of trailing slashes and query strings', () => {
    const a = parseCardUrl('https://pkmncards.com/card/aipom-paradox-rift-par-211');
    const b = parseCardUrl('https://pkmncards.com/card/aipom-paradox-rift-par-211/?foo=bar#x');
    expect(a?.number).toBe('211');
    expect(b?.number).toBe('211');
  });
});
