/**
 * PkmnCards transport layer: HTTP fetching, in-process caching and the
 * orchestration of a lookup. Parsing lives in `html-parsing`, matching rules
 * live in `card-matching`.
 */
import {
  ARTIST_SITEMAP_URL,
  ARTIST_URL_RE,
  BASE_URL,
  IMAGE_RE,
  REQUEST_HEADERS,
  SET_HREF_RE,
} from './constants';
import {
  boundedLevenshtein,
  buildCardNumberVariants,
  buildLookupCacheKey,
  buildNameVariants,
  buildSearchQueries,
  normalizeArtistText,
  normalizeCardNumber,
  normalizeSetCode,
  normalizeSetIdentity,
  normalizeSetName,
  extractNumberFromName,
  pickBestCardLink,
  slugify,
  slugifyArtist,
} from './card-matching';
import {
  decodeHtml,
  extractCardLinks,
  parseCardUrl,
  parseSetMetaFromLink,
  pickBestImageCandidate,
  slugToDisplayName,
  toAbsolutePkmnCardsUrl,
} from './html-parsing';
import type {
  ArtistCardHit,
  ArtistDirectoryEntry,
  ParsedCardUrl,
  PkmnCardsLookupInput,
  PkmnCardsLookupResult,
  ResolvedArtist,
  SetMeta,
} from './types';

export type {
  ArtistCardHit,
  ArtistDirectoryEntry,
  ParsedCardUrl,
  PkmnCardsLookupInput,
  PkmnCardsLookupResult,
  ResolvedArtist,
};
export { parseCardUrl };


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
