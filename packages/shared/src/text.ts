/**
 * Text normalizers used for fuzzy matching of card, set and artist names.
 *
 * Four variants exist because callers need different amounts of folding; they
 * are collected here so the same rule isn't re-implemented per module. Pick the
 * loosest one that still distinguishes the values you compare.
 */

/** Lowercase and drop everything that isn't a letter or digit: `"XY-133"` → `"xy133"`. */
export function normalizeAlphanumeric(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Lowercase and collapse runs of non-alphanumerics to single spaces. */
export function normalizeToSpacedAlphanumeric(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** {@link normalizeToSpacedAlphanumeric} plus diacritic folding (`"Pokémon"` → `"pokemon"`). */
export function normalizeDiacriticInsensitive(input: string): string {
  return normalizeToSpacedAlphanumeric(foldDiacritics(input));
}

/**
 * The loosest normalizer: diacritic-folded, with `&` spelled out and dashes
 * flattened, so `"Ruby & Sapphire"` and `"Ruby and Sapphire"` compare equal.
 */
export function normalizeTextForMatching(input: string): string {
  return normalizeToSpacedAlphanumeric(
    foldDiacritics(input).replace(/&/g, ' and ').replace(/[—–]/g, ' '),
  );
}

function foldDiacritics(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
