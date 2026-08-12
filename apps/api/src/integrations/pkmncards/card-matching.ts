/**
 * Pure matching rules: how a catalog row's name/set/number is normalized into
 * search queries and scored against the candidate card links a search returns.
 */
import { normalizeAlphanumeric, normalizeDiacriticInsensitive } from '@tcg/shared';
import type { PkmnCardsLookupInput } from './types';

/** Slugify a free-text artist name into pkmncards' URL segment format. */
export function slugifyArtist(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalize an artist name / slug so equality checks are diacritic- and
 * punctuation-insensitive.
 */
export const normalizeArtistText = normalizeDiacriticInsensitive;

/**
 * Levenshtein with an early-exit ceiling. Returns `max + 1` if the true
 * distance exceeds `max`, which lets callers reject quickly without paying the
 * full O(m·n) cost on wildly different strings.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export function normalizeSetCode(setCode: string | null | undefined): string {
  return normalizeAlphanumeric(setCode ?? '');
}

export function normalizeSetName(setName: string | null | undefined): string {
  return (setName ?? '').trim().replace(/\s+/g, ' ');
}

export function normalizeCardNumber(cardNumber: string | null | undefined): string {
  const head = (cardNumber ?? '')
    .trim()
    .toLowerCase()
    .split('/')[0]
    .replace(/[^a-z0-9]/g, '');
  return head;
}

export function buildCardNumberVariants(cardNumber: string | null | undefined): string[] {
  const base = normalizeCardNumber(cardNumber);
  if (!base) return [];

  const variants = new Set<string>([base]);
  if (/^\d+$/.test(base)) {
    variants.add(String(parseInt(base, 10)));
    variants.add(base.padStart(3, '0'));
  }

  return [...variants].filter(Boolean);
}

export function buildNameVariants(name: string): string[] {
  const raw = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return [];

  const noParens = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const noDecorators = noParens
    .replace(/\b(full\s*art|alt(?:ernate)?\s*art|secret|rainbow|gold|jp|japanese)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const variants = [raw, noParens, noDecorators]
    .map((v) => v.trim())
    .filter(Boolean);

  const dedup = new Map<string, string>();
  for (const v of variants) {
    const key = slugify(v);
    if (!key) continue;
    if (!dedup.has(key)) dedup.set(key, v);
  }

  return [...dedup.values()];
}

export function normalizeName(name: string): string {
  const variants = buildNameVariants(name);
  return variants[0] ?? name.trim();
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildLookupCacheKey(input: PkmnCardsLookupInput): string {
  const name = normalizeName(input.name).toLowerCase();
  const setCode = normalizeSetCode(input.setCode);
  const setName = normalizeSetName(input.setName).toLowerCase();
  const number = normalizeCardNumber(input.cardNumber) || extractNumberFromName(input.name);
  return `${name}__${setCode}__${setName}__${number}`;
}

export function buildSearchQueries(ctx: {
  setCode: string;
  setName: string;
  cardNumberVariants: string[];
  nameVariants: string[];
}): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  const setTokens: string[] = [];
  if (ctx.setCode) setTokens.push(`e:${ctx.setCode}`);
  const setNameSlug = slugify(ctx.setName);
  if (setNameSlug) setTokens.push(`set:${setNameSlug}`);

  const numberTokens = ctx.cardNumberVariants.slice(0, 2).map((n) => `number:${n}`);
  const nameTokens = ctx.nameVariants
    .slice(0, 2)
    .flatMap((n) => {
      const slug = slugify(n);
      const quoted = n.replace(/["']/g, '').trim();
      const tokens: string[] = [];
      if (quoted) tokens.push(quoted);
      if (slug) tokens.push(`name:${slug}`);
      if (quoted) tokens.push(`"${quoted}"`);
      return tokens;
    });

  const push = (...parts: Array<string | undefined>) => {
    const q = parts.filter(Boolean).join(' ').trim();
    if (!q || seen.has(q)) return;
    seen.add(q);
    queries.push(q);
  };

  for (const setToken of setTokens) {
    for (const n of numberTokens) {
      for (const nm of nameTokens) push(setToken, n, nm);
      push(setToken, n);
    }
    for (const nm of nameTokens) push(setToken, nm);
  }

  for (const n of numberTokens) {
    for (const nm of nameTokens) push(n, nm);
    push(n);
  }

  for (const nm of nameTokens) push(nm);

  return queries;
}

export function pickBestCardLink(
  links: string[],
  ctx: {
    setCode: string;
    setName: string;
    cardNumberVariants: string[];
    nameVariants: string[];
  },
): string | null {
  if (!links.length) return null;

  const nameSlugs = ctx.nameVariants.map((n) => slugify(n)).filter(Boolean);
  const setCode = ctx.setCode;
  const setNameSlug = slugify(ctx.setName);

  let best: { link: string; score: number } | null = null;
  for (const link of links) {
    const l = link.toLowerCase();
    let score = 0;

    for (const nameSlug of nameSlugs) {
      if (nameSlug && l.includes(`/${nameSlug}-`)) score += 7;
      else if (nameSlug && l.includes(nameSlug)) score += 4;
    }

    for (const number of ctx.cardNumberVariants) {
      if (number && l.includes(`-${number}/`)) score += 5;
      else if (number && l.endsWith(`-${number}`)) score += 5;
      else if (number && l.includes(`-${number}-`)) score += 3;
    }

    if (setCode && l.includes(`-${setCode}-`)) score += 3;
    if (setNameSlug && l.includes(`-${setNameSlug}-`)) score += 2;

    if (!best || score > best.score) {
      best = { link, score };
    }
  }

  return best?.link ?? links[0] ?? null;
}

export function extractNumberFromName(name: string): string {
  const m = name.match(/\(([^)]*\d[^)]*)\)/);
  if (!m?.[1]) return '';
  return normalizeCardNumber(m[1]);
}

export function normalizeSetIdentity(setName: string): string {
  const collapsed = setName
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed;
}
