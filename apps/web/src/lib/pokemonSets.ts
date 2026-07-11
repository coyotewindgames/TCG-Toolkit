/**
 * Canonical list of Pokémon TCG set names + a small alias table.
 *
 * This exists so the Trade / Buy search box can detect a set name in a free
 * text query without depending on the pkmnprices `/sets` catalog being fully
 * loaded, and so operators can type shorthand codes like "PRE" or "S&V"
 * instead of the full name.
 *
 * The canonical name is what we match against pkmnprices' set list to pull
 * the actual `set_id` used for filtering. When no pkmnprices match exists
 * (rare — mostly for very new sets that haven't landed upstream yet) the
 * detected name is still shown to the operator as an informational chip.
 */

/**
 * Canonical set names as printed by The Pokémon Company. Ordered oldest →
 * newest to bias inference toward "the most recent Charizard" when a query
 * is ambiguous — that's what stores usually want.
 */
export const POKEMON_SET_NAMES: readonly string[] = [
  'Base',
  'Jungle',
  'Wizards Black Star Promos',
  'Fossil',
  'Base Set 2',
  'Team Rocket',
  'Gym Heroes',
  'Gym Challenge',
  'Neo Genesis',
  'Neo Discovery',
  'Southern Islands',
  'Neo Revelation',
  'Neo Destiny',
  'Legendary Collection',
  'Expedition Base Set',
  'Best of Game',
  'Aquapolis',
  'Skyridge',
  'Ruby & Sapphire',
  'Sandstorm',
  'Nintendo Black Star Promos',
  'Dragon',
  'Team Magma vs Team Aqua',
  'Hidden Legends',
  'EX Trainer Kit Latias',
  'EX Trainer Kit Latios',
  'FireRed & LeafGreen',
  'POP Series 1',
  'Team Rocket Returns',
  'Deoxys',
  'Emerald',
  'Unseen Forces',
  'POP Series 2',
  'Delta Species',
  'Legend Maker',
  'EX Trainer Kit 2 Plusle',
  'EX Trainer Kit 2 Minun',
  'POP Series 3',
  'Holon Phantoms',
  'Crystal Guardians',
  'POP Series 4',
  'Dragon Frontiers',
  'Power Keepers',
  'POP Series 5',
  'Diamond & Pearl',
  'DP Black Star Promos',
  'Mysterious Treasures',
  'POP Series 6',
  'Secret Wonders',
  'Great Encounters',
  'POP Series 7',
  'Majestic Dawn',
  'Legends Awakened',
  'POP Series 8',
  'Stormfront',
  'Platinum',
  'POP Series 9',
  'Rising Rivals',
  'Supreme Victors',
  'Arceus',
  'Pokémon Rumble',
  'HeartGold & SoulSilver',
  'HGSS Black Star Promos',
  'HS—Unleashed',
  'HS—Undaunted',
  'HS—Triumphant',
  'Call of Legends',
  'BW Black Star Promos',
  'Black & White',
  "McDonald's Collection 2011",
  'Emerging Powers',
  'Noble Victories',
  'Next Destinies',
  'Dark Explorers',
  "McDonald's Collection 2012",
  'Dragons Exalted',
  'Dragon Vault',
  'Boundaries Crossed',
  'Plasma Storm',
  'Plasma Freeze',
  'Plasma Blast',
  'XY Black Star Promos',
  'Legendary Treasures',
  'Kalos Starter Set',
  'XY',
  'Flashfire',
  "McDonald's Collection 2014",
  'Furious Fists',
  'Phantom Forces',
  'Primal Clash',
  'Double Crisis',
  'Roaring Skies',
  'Ancient Origins',
  'BREAKthrough',
  "McDonald's Collection 2015",
  'BREAKpoint',
  'Generations',
  'Fates Collide',
  'Steam Siege',
  "McDonald's Collection 2016",
  'Evolutions',
  'Sun & Moon',
  'SM Black Star Promos',
  'Guardians Rising',
  'Burning Shadows',
  'Shining Legends',
  'Crimson Invasion',
  "McDonald's Collection 2017",
  'Ultra Prism',
  'Forbidden Light',
  'Celestial Storm',
  'Dragon Majesty',
  "McDonald's Collection 2018",
  'Lost Thunder',
  'Team Up',
  'Detective Pikachu',
  'Unbroken Bonds',
  'Unified Minds',
  'Hidden Fates',
  'Hidden Fates Shiny Vault',
  "McDonald's Collection 2019",
  'Cosmic Eclipse',
  'SWSH Black Star Promos',
  'Sword & Shield',
  'Rebel Clash',
  'Darkness Ablaze',
  'Pokémon Futsal Collection',
  "Champion's Path",
  'Vivid Voltage',
  "McDonald's Collection 2021",
  'Shining Fates',
  'Shining Fates Shiny Vault',
  'Battle Styles',
  'Chilling Reign',
  'Evolving Skies',
  'Celebrations',
  'Celebrations: Classic Collection',
  'Fusion Strike',
  'Brilliant Stars',
  'Brilliant Stars Trainer Gallery',
  'Astral Radiance',
  'Astral Radiance Trainer Gallery',
  'Pokémon GO',
  "McDonald's Collection 2022",
  'Lost Origin',
  'Lost Origin Trainer Gallery',
  'Silver Tempest',
  'Silver Tempest Trainer Gallery',
  'Scarlet & Violet Black Star Promos',
  'Crown Zenith',
  'Crown Zenith Galarian Gallery',
  'Scarlet & Violet',
  'Scarlet & Violet Energies',
  'Paldea Evolved',
  'Obsidian Flames',
  '151',
  'Paradox Rift',
  'Paldean Fates',
  'Temporal Forces',
  'Twilight Masquerade',
  'Shrouded Fable',
  'Stellar Crown',
  'Surging Sparks',
  'Prismatic Evolutions',
  'Journey Together',
  'Destined Rivals',
  'Black Bolt',
  'White Flare',
  'Mega Evolution',
  'Phantasmal Flames',
  'Ascended Heroes',
  'Perfect Order',
  'Chaos Rising',
];

/**
 * Common shorthand aliases → canonical set name. Keys are stored normalized
 * (see {@link normalizeSet}) so callers can do `SET_ALIASES[normalizeSet(q)]`
 * without worrying about case, ampersands, or accents.
 *
 * Add new entries when operators keep typing something we don't recognize.
 */
export const SET_ALIASES: Readonly<Record<string, string>> = {
  // Modern set codes (SV era)
  svi: 'Scarlet & Violet',
  pal: 'Paldea Evolved',
  obf: 'Obsidian Flames',
  mev: '151',
  mew: '151',
  par: 'Paradox Rift',
  paf: 'Paldean Fates',
  tef: 'Temporal Forces',
  twm: 'Twilight Masquerade',
  sfa: 'Shrouded Fable',
  scr: 'Stellar Crown',
  ssp: 'Surging Sparks',
  pre: 'Prismatic Evolutions',
  jtg: 'Journey Together',
  dri: 'Destined Rivals',
  meg: 'Mega Evolution',
  // SWSH era
  sit: 'Silver Tempest',
  lor: 'Lost Origin',
  pgo: 'Pokémon GO',
  ast: 'Astral Radiance',
  brs: 'Brilliant Stars',
  fst: 'Fusion Strike',
  cel: 'Celebrations',
  evs: 'Evolving Skies',
  cre: 'Chilling Reign',
  bst: 'Battle Styles',
  shf: 'Shining Fates',
  viv: 'Vivid Voltage',
  cpa: "Champion's Path",
  daa: 'Darkness Ablaze',
  rcl: 'Rebel Clash',
  ssh: 'Sword & Shield',
  cez: 'Crown Zenith',
  // Common word variants
  'sun and moon': 'Sun & Moon',
  'sword and shield': 'Sword & Shield',
  'scarlet and violet': 'Scarlet & Violet',
  'sv': 'Scarlet & Violet',
  'ruby and sapphire': 'Ruby & Sapphire',
  'firered and leafgreen': 'FireRed & LeafGreen',
  'diamond and pearl': 'Diamond & Pearl',
  'black and white': 'Black & White',
  'heartgold and soulsilver': 'HeartGold & SoulSilver',
  'base set': 'Base',
  'base set 2': 'Base Set 2',
  'evolving skys': 'Evolving Skies', // common typo
  'pokemon go': 'Pokémon GO',
};

/**
 * Normalize a set name or shorthand for matching. Lowercases, strips diacritics
 * (Pokémon → pokemon), collapses whitespace/punctuation, replaces `&` with
 * `and`, and squashes em/en dashes so lookups are consistent regardless of
 * how the user typed it.
 */
export function normalizeSet(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[—–]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Break a normalized string into tokens ≥ 3 chars long. Short tokens
 * (roman numerals, joiners like "of"/"to") match too aggressively and are
 * dropped.
 */
export function tokenizeSet(input: string): string[] {
  return normalizeSet(input)
    .split(' ')
    .filter((token) => token.length >= 3);
}

/**
 * A canonical name that matched a query, plus where inside the query it was
 * detected (for downstream substring-stripping when composing the pkmnprices
 * `q=` param).
 */
export interface SetMatch {
  /** Canonical set name from {@link POKEMON_SET_NAMES}. */
  name: string;
  /** Index in the original (unnormalized) query where the match starts. */
  start: number;
  /** Length in the original query occupied by the match. */
  length: number;
  /**
   * How we matched — used only for chip labelling / debugging.
   * - `alias`  → matched via {@link SET_ALIASES}
   * - `exact`  → the full canonical name appears verbatim
   * - `tokens` → every significant token of the canonical name appears
   */
  matchedBy: 'alias' | 'exact' | 'tokens';
}

/**
 * Detect a set reference inside a free-text query. Returns the highest-scoring
 * match (canonical name occurrence length), or `null` if nothing hit.
 *
 * Strategy order (later strategies only try if earlier ones missed):
 *   1. Alias map — matches "PRE" / "SVI" / "sword and shield"
 *   2. Exact substring of the full canonical name
 *   3. All significant tokens of the canonical name appear in the query
 *
 * Multi-word matches beat single-word matches so "Evolving Skies" wins over
 * bare "Base" on a query like "rayquaza evolving skies base attack".
 */
export function detectSet(query: string): SetMatch | null {
  const raw = query.trim();
  if (!raw) return null;
  const normalized = normalizeSet(raw);
  if (!normalized) return null;

  // 1. Alias lookup: single-token queries match aliases outright; multi-token
  //    queries scan for the alias as a whole token so "PRE" inside
  //    "Prehistoric attack" doesn't false-trigger.
  const aliasHit = matchAlias(raw, normalized);
  if (aliasHit) return aliasHit;

  // 2. Substring match on canonical names.
  let bestSubstring: SetMatch | null = null;
  for (const name of POKEMON_SET_NAMES) {
    const needle = normalizeSet(name);
    if (needle.length < 3) continue;
    const idx = normalized.indexOf(needle);
    if (idx === -1) continue;
    const score = needle.length;
    if (!bestSubstring || score > bestSubstring.length) {
      const range = locateRangeInOriginal(raw, name);
      bestSubstring = {
        name,
        start: range.start,
        length: range.length,
        matchedBy: 'exact',
      };
    }
  }
  if (bestSubstring) return bestSubstring;

  // 3. All-tokens present.
  const queryTokens = new Set(tokenizeSet(raw));
  if (queryTokens.size === 0) return null;

  let bestTokens: SetMatch | null = null;
  for (const name of POKEMON_SET_NAMES) {
    const setTokens = tokenizeSet(name);
    if (setTokens.length === 0) continue;
    const allMatch = setTokens.every((token) => queryTokens.has(token));
    if (!allMatch) continue;
    const score = setTokens.reduce((sum, token) => sum + token.length, 0);
    if (bestTokens && score <= bestTokens.length) continue;
    const range = locateRangeInOriginal(raw, name);
    bestTokens = {
      name,
      start: range.start,
      length: range.length,
      matchedBy: 'tokens',
    };
  }
  return bestTokens;
}

/**
 * Autocomplete-style suggestion list. Returns up to `limit` canonical names
 * that share a prefix or token with `query`. Empty query returns [].
 */
export function suggestSets(query: string, limit = 5): string[] {
  const normalized = normalizeSet(query);
  if (!normalized) return [];
  const tokens = tokenizeSet(query);
  const results: Array<{ name: string; score: number }> = [];

  for (const name of POKEMON_SET_NAMES) {
    const normName = normalizeSet(name);
    let score = 0;

    // Prefer full-string prefix hits ("evolv" → "Evolving Skies").
    if (normName.startsWith(normalized)) score += 100;
    else if (normName.includes(normalized)) score += 40;

    // Award token-level prefix hits so "PRE" also surfaces Prismatic Evolutions.
    for (const t of tokens) {
      for (const nt of normName.split(' ')) {
        if (!nt) continue;
        if (nt === t) score += 20;
        else if (nt.startsWith(t)) score += 10;
      }
    }

    if (score > 0) results.push({ name, score });
  }

  // Alias hits should surface their canonical name too.
  const aliasCanonical = SET_ALIASES[normalized];
  if (aliasCanonical) {
    results.push({ name: aliasCanonical, score: 200 });
  }

  const seen = new Set<string>();
  return results
    .sort((a, b) => b.score - a.score)
    .filter((r) => {
      if (seen.has(r.name)) return false;
      seen.add(r.name);
      return true;
    })
    .slice(0, limit)
    .map((r) => r.name);
}

// ---------------------------------------------------------------------------

function matchAlias(raw: string, normalized: string): SetMatch | null {
  // Whole-query alias match wins ("pre", "svi").
  const whole = SET_ALIASES[normalized];
  if (whole) {
    return { name: whole, start: 0, length: raw.length, matchedBy: 'alias' };
  }
  // Otherwise scan tokens.
  const rawTokens = raw.split(/\s+/);
  let cursor = 0;
  for (const token of rawTokens) {
    const start = raw.indexOf(token, cursor);
    if (start === -1) {
      cursor += token.length + 1;
      continue;
    }
    const canonical = SET_ALIASES[normalizeSet(token)];
    if (canonical) {
      return { name: canonical, start, length: token.length, matchedBy: 'alias' };
    }
    cursor = start + token.length;
  }
  return null;
}

/**
 * Best-effort locator: find where the canonical set name (or its first
 * significant token) begins in the raw query. We use this to strip the set
 * substring out of the outgoing pkmnprices `q=` param so the upstream
 * name-search doesn't get confused by extra words.
 */
function locateRangeInOriginal(raw: string, canonical: string): { start: number; length: number } {
  const lowerRaw = raw.toLowerCase();
  const lowerName = canonical.toLowerCase();
  const idx = lowerRaw.indexOf(lowerName);
  if (idx !== -1) return { start: idx, length: canonical.length };

  const tokens = tokenizeSet(canonical);
  if (tokens.length === 0) return { start: 0, length: 0 };
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const startIdx = lowerRaw.indexOf(first);
  if (startIdx === -1) return { start: 0, length: 0 };
  const endIdx = lowerRaw.lastIndexOf(last);
  const end = endIdx === -1 ? startIdx + first.length : endIdx + last.length;
  return { start: startIdx, length: Math.max(first.length, end - startIdx) };
}
