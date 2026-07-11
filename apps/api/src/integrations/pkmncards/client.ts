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

/** Directory entry pulled from `pkmn_artist-sitemap.xml`. */
export interface ArtistDirectoryEntry {
  slug: string;
  /** Slug rewritten as a display label, e.g. `yuka-morii` → `Yuka Morii`. */
  displayName: string;
}

/** Card URL parsed from an artist index page, e.g. `/card/aipom-paradox-rift-par-211/`. */
export interface ParsedCardUrl {
  cardUrl: string;
  /** Best-guess slug for the card name (may include hyphens). */
  nameSlug: string;
  /** Set slug (may be null if we can't align with the known set directory). */
  setSlug: string | null;
  /** Set code (2–5 alpha chars) — the reliable join key. */
  setCode: string;
  /** Card number as it appears on the printed card. */
  number: string;
}

/** A single hit returned by {@link PkmnCardsClient.searchByArtistSlug}. */
export interface ArtistCardHit extends ParsedCardUrl {
  /** Best-effort display name from the slug (Title Case). */
  displayName: string;
}

/** Result of {@link PkmnCardsClient.resolveArtistSlug}. */
export interface ResolvedArtist {
  slug: string;
  displayName: string;
  /** How we found the slug — used only for logging/analytics. */
  method: 'direct' | 'exact' | 'substring' | 'tokens' | 'lastname' | 'levenshtein';
}

const BASE_URL = 'https://pkmncards.com';
const ARTIST_SITEMAP_URL = `${BASE_URL}/pkmn_artist-sitemap.xml`;
const CARD_HREF_RE = /href=["']([^"']*\/card\/[^"']+)["']/gi;
const SET_HREF_RE = /href=["']([^"']*\/set\/[^"']+\/)["'][^>]*>([^<]+)<\/a>/gi;
const IMAGE_RE = /(?:https?:\/\/pkmncards\.com)?\/wp-content\/uploads\/[^"'\s<>]+\.(?:jpg|jpeg|png)/gi;
const ARTIST_URL_RE = /<loc>\s*(https?:\/\/pkmncards\.com\/artist\/([^/<]+)\/)\s*<\/loc>/gi;
/** `{name-slug}-{set-slug}-{set-code}-{number}` — code is 1–5 lowercase alpha. */
const CARD_URL_TAIL_RE = /^(?<head>.+)-(?<code>[a-z]{1,5})-(?<number>[a-z0-9]+)$/i;

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

  // --- Artist directory + search (see `listArtists` / `searchByArtistSlug`) ---
  private artistDirectory: ArtistDirectoryEntry[] | null = null;
  private artistDirectoryLoadedAt = 0;
  private artistDirectoryPromise: Promise<ArtistDirectoryEntry[]> | null = null;
  private readonly artistLookup = new Map<string, ResolvedArtist | null>();
  private readonly artistCardLinksByKey = new Map<string, string[]>();
  private static readonly ARTIST_DIRECTORY_TTL_MS = 24 * 60 * 60_000;

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
    const candidates: string[] = [];
    for (const raw of rawImages) {
      const imageUrl = toAbsolutePkmnCardsUrl(raw);
      if (!imageUrl) continue;
      // Ignore resized thumbs and tiny assets; keep full card scans.
      if (/-(?:\d{2,4})x(?:\d{2,4})\.(?:jpg|jpeg|png)$/i.test(imageUrl)) continue;
      candidates.push(imageUrl);
    }

    const picked = pickBestImageCandidate(candidates);
    if (picked) {
      this.imageByCardUrl.set(cardUrl, picked);
      return picked;
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

  // ---------------------------------------------------------------------------
  // Artist directory + search
  // ---------------------------------------------------------------------------

  /**
   * Load and cache the full artist directory (sourced from
   * `pkmn_artist-sitemap.xml`). Cached in-process for 24 h — the sitemap is
   * only ~30 KB so a full refresh is cheap.
   */
  async listArtists(): Promise<ArtistDirectoryEntry[]> {
    const fresh =
      this.artistDirectory &&
      Date.now() - this.artistDirectoryLoadedAt < PkmnCardsClient.ARTIST_DIRECTORY_TTL_MS;
    if (fresh && this.artistDirectory) return this.artistDirectory;
    if (this.artistDirectoryPromise) return this.artistDirectoryPromise;

    this.artistDirectoryPromise = (async () => {
      const xml = await this.fetchHtml(ARTIST_SITEMAP_URL);
      const entries: ArtistDirectoryEntry[] = [];
      const seen = new Set<string>();
      let match: RegExpExecArray | null;
      const re = new RegExp(ARTIST_URL_RE.source, 'gi');
      while ((match = re.exec(xml)) !== null) {
        const slug = match[2]?.toLowerCase();
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        entries.push({ slug, displayName: slugToDisplayName(slug) });
      }
      entries.sort((a, b) => a.slug.localeCompare(b.slug));
      this.artistDirectory = entries;
      this.artistDirectoryLoadedAt = Date.now();
      return entries;
    })().finally(() => {
      this.artistDirectoryPromise = null;
    });

    return this.artistDirectoryPromise;
  }

  /**
   * Best-effort resolution of a free-text artist name (e.g. `"yuka mori"`) to a
   * canonical pkmncards slug. Tries:
   *   1. Direct URL probe with a naïve slugified input (fast, no directory fetch).
   *   2. Exact / substring / all-token match against the directory.
   *   3. Last-name substring — handles typed `"himeno"` → `kagemaru-himeno`.
   *   4. Levenshtein ≤ 2 on the slug or its last token — handles typos like
   *      `"yuka mori"` → `yuka-morii` and `"yuki morii"` → `yuka-morii`.
   *
   * Returns `null` when no match is confident enough.
   */
  async resolveArtistSlug(freeText: string): Promise<ResolvedArtist | null> {
    const trimmed = freeText.trim();
    if (!trimmed) return null;
    const key = normalizeArtistText(trimmed);
    if (!key) return null;
    if (this.artistLookup.has(key)) return this.artistLookup.get(key) ?? null;

    // 1. Naïve slug probe. If pkmncards has that exact slug we're done without
    //    loading the directory. Skip when the input already contains characters
    //    that would slugify away (would produce spurious 404s).
    const naiveSlug = slugifyArtist(trimmed);
    if (naiveSlug) {
      const exists = await this.urlExists(`${BASE_URL}/artist/${naiveSlug}/`);
      if (exists) {
        const hit: ResolvedArtist = {
          slug: naiveSlug,
          displayName: slugToDisplayName(naiveSlug),
          method: 'direct',
        };
        this.artistLookup.set(key, hit);
        return hit;
      }
    }

    const directory = await this.listArtists().catch(() => [] as ArtistDirectoryEntry[]);
    if (directory.length === 0) {
      this.artistLookup.set(key, null);
      return null;
    }

    const queryTokens = key.split(' ').filter(Boolean);
    const queryLast = queryTokens[queryTokens.length - 1] ?? key;

    // 2. Exact slug or normalized-display equality.
    for (const entry of directory) {
      if (entry.slug === naiveSlug || normalizeArtistText(entry.displayName) === key) {
        const hit: ResolvedArtist = { ...entry, method: 'exact' };
        this.artistLookup.set(key, hit);
        return hit;
      }
    }

    // 3. Substring / all-tokens-present.
    let substringHit: ResolvedArtist | null = null;
    let tokenHit: ResolvedArtist | null = null;
    let lastnameHit: ResolvedArtist | null = null;
    for (const entry of directory) {
      const normDisplay = normalizeArtistText(entry.displayName);
      const normTokens = normDisplay.split(' ').filter(Boolean);
      if (!substringHit && (normDisplay.includes(key) || key.includes(normDisplay))) {
        substringHit = { ...entry, method: 'substring' };
      }
      if (!tokenHit && queryTokens.length > 0 && queryTokens.every((t) => normDisplay.includes(t))) {
        tokenHit = { ...entry, method: 'tokens' };
      }
      if (!lastnameHit && normTokens.length > 0) {
        const entryLast = normTokens[normTokens.length - 1];
        if (entryLast === queryLast || entryLast.startsWith(queryLast) || queryLast.startsWith(entryLast)) {
          lastnameHit = { ...entry, method: 'lastname' };
        }
      }
    }
    const priority = substringHit ?? tokenHit ?? lastnameHit;
    if (priority) {
      this.artistLookup.set(key, priority);
      return priority;
    }

    // 4. Levenshtein ≤ 2 on the full display name or its last token.
    let best: { entry: ArtistDirectoryEntry; distance: number } | null = null;
    for (const entry of directory) {
      const normDisplay = normalizeArtistText(entry.displayName);
      const distanceFull = boundedLevenshtein(normDisplay, key, 2);
      const entryTokens = normDisplay.split(' ').filter(Boolean);
      const entryLast = entryTokens[entryTokens.length - 1] ?? normDisplay;
      const distanceLast = boundedLevenshtein(entryLast, queryLast, 2);
      const distance = Math.min(distanceFull, distanceLast);
      if (distance <= 2 && (!best || distance < best.distance)) {
        best = { entry, distance };
      }
    }
    if (best) {
      const hit: ResolvedArtist = { ...best.entry, method: 'levenshtein' };
      this.artistLookup.set(key, hit);
      return hit;
    }

    this.artistLookup.set(key, null);
    return null;
  }

  /**
   * Fetch a page of card URLs for a given artist slug. `page` is 1-based to
   * match pkmncards' own pagination (`/artist/<slug>/page/2/`). Results are
   * cached per (slug, page).
   */
  async searchByArtistSlug(slug: string, page = 1): Promise<ArtistCardHit[]> {
    const normSlug = slug.trim().toLowerCase();
    if (!normSlug) return [];
    const key = `${normSlug}|${page}`;
    if (this.artistCardLinksByKey.has(key)) {
      const cached = this.artistCardLinksByKey.get(key) ?? [];
      return cached.map((url) => this.buildArtistHit(url)).filter((h): h is ArtistCardHit => h !== null);
    }

    const url =
      page <= 1
        ? `${BASE_URL}/artist/${normSlug}/`
        : `${BASE_URL}/artist/${normSlug}/page/${page}/`;

    let html: string;
    try {
      html = await this.fetchHtml(url);
    } catch {
      this.artistCardLinksByKey.set(key, []);
      return [];
    }

    const links = extractCardLinks(html);
    this.artistCardLinksByKey.set(key, links);
    return links.map((u) => this.buildArtistHit(u)).filter((h): h is ArtistCardHit => h !== null);
  }

  private buildArtistHit(url: string): ArtistCardHit | null {
    const parsed = parseCardUrl(url);
    if (!parsed) return null;
    return { ...parsed, displayName: slugToDisplayName(parsed.nameSlug) };
  }

  /**
   * Public accessor for the set directory keyed by pkmncards set code (e.g.
   * `par` → { slug: 'paradox-rift', name: 'Paradox Rift', code: 'par' }).
   * Used by the artist-search hydration path to translate a parsed card URL
   * into a pkmnprices set id.
   */
  async getSetMetaByCode(code: string): Promise<{ slug: string; name: string; code: string } | null> {
    const norm = normalizeSetCode(code);
    if (!norm) return null;
    await this.ensureSetDirectory();
    return this.setByCode.get(norm) ?? null;
  }
}

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

/** Slugify a free-text artist name into pkmncards' URL segment format. */
function slugifyArtist(input: string): string {
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
function normalizeArtistText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Convert `yuka-morii` → `Yuka Morii` for display. */
function slugToDisplayName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Levenshtein with an early-exit ceiling. Returns `max + 1` if the true
 * distance exceeds `max`, which lets callers reject quickly without paying the
 * full O(m·n) cost on wildly different strings.
 */
function boundedLevenshtein(a: string, b: string, max: number): number {
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

function pickBestImageCandidate(urls: string[]): string | null {
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
