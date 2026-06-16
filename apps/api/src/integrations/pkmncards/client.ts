export interface PkmnCardsLookupInput {
  name: string;
  setCode: string | null;
  setName: string | null;
  cardNumber: string | null;
}

export interface PkmnCardsLookupResult {
  imageUrl: string;
  cardUrl: string | null;
  method: 'deterministic' | 'search';
}

interface SetMeta {
  slug: string;
  name: string;
  code: string;
}

const BASE_URL = 'https://pkmncards.com';
const CARD_HREF_RE = /href=["']([^"']*\/card\/[^"']+)["']/gi;
const SET_HREF_RE = /href=["']([^"']*\/set\/[^"']+\/)["'][^>]*>([^<]+)<\/a>/gi;
const IMAGE_RE = /(?:https?:\/\/pkmncards\.com)?\/wp-content\/uploads\/[^"'\s<>]+\.(?:jpg|jpeg|png)/gi;

const REQUEST_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml',
  'user-agent': 'TCG-Toolkit/1.0 (+inventory image enrichment)',
};

/**
 * PkmnCards HTML-backed client. We prefer deterministic image URL guesses
 * from (set code + card number), then fall back to one targeted search query
 * and scrape the first card page for the image URL.
 */
export class PkmnCardsClient {
  private readonly htmlByUrl = new Map<string, string>();
  private readonly imageByCardUrl = new Map<string, string | null>();
  private readonly cardLinksBySearchQuery = new Map<string, string[]>();
  private readonly lookupCache = new Map<string, PkmnCardsLookupResult | null>();
  private readonly existsByUrl = new Map<string, boolean>();
  private readonly setByNormalizedName = new Map<string, SetMeta>();
  private readonly setByCode = new Map<string, SetMeta>();
  private readonly cardLinksBySetSlug = new Map<string, string[]>();
  private setsLoaded = false;

  async lookup(input: PkmnCardsLookupInput): Promise<PkmnCardsLookupResult | null> {
    const lookupKey = buildLookupCacheKey(input);
    if (this.lookupCache.has(lookupKey)) {
      return this.lookupCache.get(lookupKey) ?? null;
    }

    const setCode = normalizeSetCode(input.setCode);
    const setName = normalizeSetName(input.setName);
    const explicitNumber = normalizeCardNumber(input.cardNumber);
    const inferredNumber = explicitNumber || extractNumberFromName(input.name);
    const numberVariants = buildCardNumberVariants(inferredNumber);
    const nameVariants = buildNameVariants(input.name);
    const setMeta = await this.resolveSetMeta({ setName, setCode });
    const effectiveSetCode = setCode || setMeta?.code || '';

    if (effectiveSetCode && numberVariants.length) {
      const deterministic = await this.tryDeterministicImage(effectiveSetCode, numberVariants);
      if (deterministic) {
        const hit: PkmnCardsLookupResult = {
          imageUrl: deterministic,
          cardUrl: null,
          method: 'deterministic',
        };
        this.lookupCache.set(lookupKey, hit);
        return hit;
      }
    }

    if (setMeta && numberVariants.length && nameVariants.length) {
      const directCard = await this.tryDirectCardUrl(setMeta, nameVariants, numberVariants);
      if (directCard) {
        const directImage = await this.extractImageFromCard(directCard);
        if (directImage) {
          const hit: PkmnCardsLookupResult = {
            imageUrl: directImage,
            cardUrl: directCard,
            method: 'search',
          };
          this.lookupCache.set(lookupKey, hit);
          return hit;
        }
      }

      const setLinks = await this.getSetCardLinks(setMeta.slug);
      if (setLinks.length) {
        const picked = pickBestCardLink(setLinks, {
          setCode: effectiveSetCode,
          setName,
          cardNumberVariants: numberVariants,
          nameVariants,
        });
        if (picked) {
          const setImage = await this.extractImageFromCard(picked);
          if (setImage) {
            const hit: PkmnCardsLookupResult = {
              imageUrl: setImage,
              cardUrl: picked,
              method: 'search',
            };
            this.lookupCache.set(lookupKey, hit);
            return hit;
          }
        }
      }
    }

    const cardUrl = await this.findCardUrlBySearch({
      setCode: effectiveSetCode,
      setName,
      cardNumberVariants: numberVariants,
      nameVariants,
    });
    if (!cardUrl) {
      this.lookupCache.set(lookupKey, null);
      return null;
    }

    const imageUrl = await this.extractImageFromCard(cardUrl);
    if (!imageUrl) {
      this.lookupCache.set(lookupKey, null);
      return null;
    }

    const hit: PkmnCardsLookupResult = {
      imageUrl,
      cardUrl,
      method: 'search',
    };
    this.lookupCache.set(lookupKey, hit);
    return hit;
  }

  private async tryDirectCardUrl(
    setMeta: SetMeta,
    nameVariants: string[],
    numberVariants: string[],
  ): Promise<string | null> {
    const names = nameVariants.slice(0, 2).map(slugify).filter(Boolean);
    const numbers = numberVariants.slice(0, 2);

    for (const name of names) {
      for (const number of numbers) {
        if (!setMeta.code) continue;
        const candidate = `${BASE_URL}/card/${name}-${setMeta.slug}-${setMeta.code}-${number}/`;
        if (await this.urlExists(candidate)) return candidate;
      }
    }

    return null;
  }

  private async ensureSetDirectory(): Promise<void> {
    if (this.setsLoaded) return;
    const html = await this.fetchHtml(`${BASE_URL}/sets/`);

    let m: RegExpExecArray | null;
    SET_HREF_RE.lastIndex = 0;
    while ((m = SET_HREF_RE.exec(html)) !== null) {
      const href = m[1] ?? '';
      const label = decodeHtml(m[2] ?? '').trim();
      const setMeta = parseSetMetaFromLink(href, label);
      if (!setMeta) continue;

      const normalized = normalizeSetIdentity(setMeta.name);
      if (normalized && !this.setByNormalizedName.has(normalized)) {
        this.setByNormalizedName.set(normalized, setMeta);
      }
      if (setMeta.code && !this.setByCode.has(setMeta.code)) {
        this.setByCode.set(setMeta.code, setMeta);
      }
    }

    this.setsLoaded = true;
  }

  private async resolveSetMeta(input: { setName: string; setCode: string }): Promise<SetMeta | null> {
    await this.ensureSetDirectory();

    if (input.setCode) {
      const byCode = this.setByCode.get(input.setCode);
      if (byCode) return byCode;
    }

    const normalized = normalizeSetIdentity(input.setName);
    if (normalized) {
      const byName = this.setByNormalizedName.get(normalized);
      if (byName) return byName;

      // Common CSV pattern: "Generations: Radiant Collection".
      const parts = input.setName
        .split(':')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normalizeSetIdentity);
      for (const part of parts) {
        if (!part) continue;
        const hit = this.setByNormalizedName.get(part);
        if (hit) return hit;
      }
    }

    return null;
  }

  private async getSetCardLinks(setSlug: string): Promise<string[]> {
    const cached = this.cardLinksBySetSlug.get(setSlug);
    if (cached) return cached;

    const html = await this.fetchHtml(`${BASE_URL}/set/${setSlug}/`);
    const links = extractCardLinks(html);
    this.cardLinksBySetSlug.set(setSlug, links);
    return links;
  }

  private async tryDeterministicImage(
    setCode: string,
    cardNumbers: string[],
  ): Promise<string | null> {
    const extensions = ['jpg', 'png', 'jpeg'];

    for (const cardNumber of cardNumbers) {
      const candidates = extensions.map(
        (ext) => `${BASE_URL}/wp-content/uploads/${setCode}_en_${cardNumber}_std.${ext}`,
      );

      for (const url of candidates) {
        if (await this.urlExists(url)) return url;
      }
    }

    return null;
  }

  private async findCardUrlBySearch(ctx: {
    setCode: string;
    setName: string;
    cardNumberVariants: string[];
    nameVariants: string[];
  }): Promise<string | null> {
    const queries = buildSearchQueries(ctx);
    for (const query of queries) {
      const links = await this.searchCardLinks(query);
      if (!links.length) continue;

      const picked = pickBestCardLink(links, ctx);
      if (picked) return picked;
    }

    return null;
  }

  private async searchCardLinks(query: string): Promise<string[]> {
    const cached = this.cardLinksBySearchQuery.get(query);
    if (cached) return cached;

    const params = new URLSearchParams();
    params.set('s', query);
    params.set('display', 'images');
    params.set('sort', 'date');
    params.set('order', 'asc');

    const searchUrl = `${BASE_URL}/?${params.toString()}`;
    const html = await this.fetchHtml(searchUrl);
    const links = extractCardLinks(html);
    this.cardLinksBySearchQuery.set(query, links);
    return links;
  }

  private async extractImageFromCard(cardUrl: string): Promise<string | null> {
    if (this.imageByCardUrl.has(cardUrl)) {
      return this.imageByCardUrl.get(cardUrl) ?? null;
    }

    const html = await this.fetchHtml(cardUrl);
    const rawImages = html.match(IMAGE_RE) ?? [];
    for (const raw of rawImages) {
      const imageUrl = toAbsolutePkmnCardsUrl(raw);
      if (!imageUrl) continue;
      if (!imageUrl.includes('_std.')) continue;
      this.imageByCardUrl.set(cardUrl, imageUrl);
      return imageUrl;
    }

    this.imageByCardUrl.set(cardUrl, null);
    return null;
  }

  private async fetchHtml(url: string): Promise<string> {
    const cached = this.htmlByUrl.get(url);
    if (cached) return cached;

    const res = await fetch(url, {
      method: 'GET',
      headers: REQUEST_HEADERS,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`pkmncards ${url} -> ${res.status}: ${body.slice(0, 160)}`);
    }

    const html = await res.text();
    this.htmlByUrl.set(url, html);
    return html;
  }

  private async urlExists(url: string): Promise<boolean> {
    if (this.existsByUrl.has(url)) {
      return this.existsByUrl.get(url) ?? false;
    }

    const exists = await urlExists(url);
    this.existsByUrl.set(url, exists);
    return exists;
  }
}

function normalizeSetCode(setCode: string | null | undefined): string {
  return (setCode ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeSetName(setName: string | null | undefined): string {
  return (setName ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeCardNumber(cardNumber: string | null | undefined): string {
  const head = (cardNumber ?? '')
    .trim()
    .toLowerCase()
    .split('/')[0]
    .replace(/[^a-z0-9]/g, '');
  return head;
}

function buildCardNumberVariants(cardNumber: string | null | undefined): string[] {
  const base = normalizeCardNumber(cardNumber);
  if (!base) return [];

  const variants = new Set<string>([base]);
  if (/^\d+$/.test(base)) {
    variants.add(String(parseInt(base, 10)));
    variants.add(base.padStart(3, '0'));
  }

  return [...variants].filter(Boolean);
}

function buildNameVariants(name: string): string[] {
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

function normalizeName(name: string): string {
  const variants = buildNameVariants(name);
  return variants[0] ?? name.trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizeUrl(value: string): string | null {
  try {
    const u = new URL(value);
    return u.toString();
  } catch {
    return null;
  }
}

function toAbsolutePkmnCardsUrl(value: string): string | null {
  const trimmed = value.trim();
  const absolute = trimmed.startsWith('http')
    ? trimmed
    : `${BASE_URL}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
  const normalized = sanitizeUrl(absolute);
  if (!normalized) return null;
  if (!normalized.startsWith(`${BASE_URL}/`)) return null;
  return normalized;
}

function extractCardLinks(html: string): string[] {
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

function buildLookupCacheKey(input: PkmnCardsLookupInput): string {
  const name = normalizeName(input.name).toLowerCase();
  const setCode = normalizeSetCode(input.setCode);
  const setName = normalizeSetName(input.setName).toLowerCase();
  const number = normalizeCardNumber(input.cardNumber) || extractNumberFromName(input.name);
  return `${name}__${setCode}__${setName}__${number}`;
}

function buildSearchQueries(ctx: {
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

function pickBestCardLink(
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

async function urlExists(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: 'HEAD', headers: REQUEST_HEADERS });
    if (head.ok) return true;

    // Some hosts don't serve HEAD reliably; lightweight GET fallback.
    if (head.status === 405 || head.status === 403 || head.status === 400) {
      const get = await fetch(url, { method: 'GET', headers: REQUEST_HEADERS });
      return get.ok;
    }

    return false;
  } catch {
    return false;
  }
}

function extractNumberFromName(name: string): string {
  const m = name.match(/\(([^)]*\d[^)]*)\)/);
  if (!m?.[1]) return '';
  return normalizeCardNumber(m[1]);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseSetMetaFromLink(href: string, label: string): SetMeta | null {
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

function normalizeSetIdentity(setName: string): string {
  const collapsed = setName
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed;
}
