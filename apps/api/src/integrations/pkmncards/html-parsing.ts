/** Pure HTML/URL parsing for pkmncards pages: no network, no matching rules. */
import { BASE_URL, CARD_HREF_RE, CARD_URL_TAIL_RE } from './constants';
import { normalizeSetCode } from './card-matching';
import type { ParsedCardUrl, SetMeta } from './types';

/**
 * Parse a pkmncards card URL into its structured pieces. Returns `null` for
 * URLs that don't match the standard `{name}-{set}-{code}-{number}` shape.
 *
 * Exported for use by the pkmnprices hydration path and for unit testing.
 */
export function parseCardUrl(input: string): ParsedCardUrl | null {
  if (!input) return null;
  const trimmed = input.trim();
  const absolute = trimmed.startsWith('http')
    ? trimmed
    : trimmed.startsWith('/')
      ? `${BASE_URL}${trimmed}`
      : `${BASE_URL}/${trimmed}`;
  const withoutQuery = absolute.split('#')[0].split('?')[0];
  const noTrailing = withoutQuery.replace(/\/+$/, '');
  const idx = noTrailing.indexOf('/card/');
  if (idx === -1) return null;
  const tail = noTrailing.slice(idx + '/card/'.length);
  if (!tail) return null;
  const match = CARD_URL_TAIL_RE.exec(tail);
  if (!match || !match.groups) return null;
  const { head, code, number } = match.groups as { head: string; code: string; number: string };
  return {
    cardUrl: `${noTrailing}/`,
    nameSlug: head,
    setSlug: null,
    setCode: code.toLowerCase(),
    number: number.toLowerCase(),
  };
}

/** Convert `yuka-morii` → `Yuka Morii` for display. */
export function slugToDisplayName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function sanitizeUrl(value: string): string | null {
  try {
    const u = new URL(value);
    return u.toString();
  } catch {
    return null;
  }
}

export function toAbsolutePkmnCardsUrl(value: string): string | null {
  const trimmed = value.trim();
  const absolute = trimmed.startsWith('http')
    ? trimmed
    : `${BASE_URL}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
  const normalized = sanitizeUrl(absolute);
  if (!normalized) return null;
  if (!normalized.startsWith(`${BASE_URL}/`)) return null;
  return normalized;
}

export function extractCardLinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  CARD_HREF_RE.lastIndex = 0;
  while ((match = CARD_HREF_RE.exec(html)) !== null) {
    const link = toAbsolutePkmnCardsUrl(match[1] ?? '');
    if (!link) continue;
    if (!link.includes('/card/')) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    out.push(link);
  }

  return out;
}

export function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function parseSetMetaFromLink(href: string, label: string): SetMeta | null {
  const full = toAbsolutePkmnCardsUrl(href);
  if (!full) return null;
  const m = full.match(/\/set\/([^/]+)\/?$/i);
  if (!m?.[1]) return null;

  const codeMatch = label.match(/\(([^)]+)\)\s*$/);
  const code = normalizeSetCode(codeMatch?.[1] ?? '');
  const name = label.replace(/\s*\([^)]+\)\s*$/, '').trim();
  return {
    slug: m[1].toLowerCase(),
    name,
    code,
  };
}

export function pickBestImageCandidate(urls: string[]): string | null {
  if (!urls.length) return null;

  let best: { url: string; score: number } | null = null;
  for (const url of urls) {
    let score = 0;
    if (/_std\.(?:jpg|jpeg|png)$/i.test(url)) score += 5;
    if (/\/en_[a-z]{2}-/i.test(url)) score += 3;
    if (/\.(?:jpg|jpeg)$/i.test(url)) score += 1;
    if (!best || score > best.score) {
      best = { url, score };
    }
  }

  return best?.url ?? urls[0] ?? null;
}
