import { describe, expect, it } from 'vitest';
import { detectSet, normalizeSet, suggestSets } from './pokemonSets';

describe('pokemonSets.detectSet', () => {
  it('returns null for empty or trivial input', () => {
    expect(detectSet('')).toBeNull();
    expect(detectSet('   ')).toBeNull();
  });

  it('matches shorthand aliases', () => {
    expect(detectSet('rayquaza PRE')?.name).toBe('Prismatic Evolutions');
    expect(detectSet('svi')?.name).toBe('Scarlet & Violet');
    expect(detectSet('charizard obf')?.name).toBe('Obsidian Flames');
  });

  it('prefers the longest canonical substring match', () => {
    // Between two overlapping matches, the longer canonical name wins so
    // multi-word sets like "Evolving Skies" beat single-word sets like "Base"
    // on ambiguous queries.
    const hit = detectSet('rayquaza evolving skies base attack');
    expect(hit?.name).toBe('Evolving Skies');
  });

  it('handles ampersand / diacritic variants', () => {
    expect(detectSet('rayquaza scarlet & violet')?.name).toBe('Scarlet & Violet');
    expect(detectSet('pokemon go pikachu')?.name).toBe('Pokémon GO');
  });

  it('falls back to all-tokens-present matching', () => {
    const hit = detectSet('some rayquaza evolving skies alt art');
    expect(hit?.name).toBe('Evolving Skies');
  });

  it('normalizes ampersands and diacritics consistently', () => {
    expect(normalizeSet('Scarlet & Violet')).toBe('scarlet and violet');
    expect(normalizeSet('Pokémon GO')).toBe('pokemon go');
  });
});

describe('pokemonSets.suggestSets', () => {
  it('surfaces prefix matches first', () => {
    const suggestions = suggestSets('evolv', 5);
    expect(suggestions[0]).toBe('Evolving Skies');
  });

  it('returns empty for empty input', () => {
    expect(suggestSets('', 5)).toEqual([]);
  });

  it('includes canonical name for alias hits', () => {
    const suggestions = suggestSets('pre', 5);
    expect(suggestions).toContain('Prismatic Evolutions');
  });
});
