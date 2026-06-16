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

const BASE_URL = 'https://pkmncards.com';
const CARD_LINK_RE = /https:\/\/pkmncards\.com\/card\/[^"'\s<>]+/gi;
const IMAGE_RE = /https:\/\/pkmncards\.com\/wp-content\/uploads\/[^"'\s<>]+\.(?:jpg|jpeg|png)/gi;

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

  async lookup(input: PkmnCardsLookupInput): Promise<PkmnCardsLookupResult | null> {
    const setCode = normalizeSetCode(input.setCode);
    const number = normalizeCardNumber(input.cardNumber);

    if (setCode && number) {
      const deterministic = await this.tryDeterministicImage(setCode, number);
      if (deterministic) {
        return {
          imageUrl: deterministic,
          cardUrl: null,
          method: 'deterministic',
        };
      }
    }

    const cardUrl = await this.findCardUrlBySearch(input);
    if (!cardUrl) return null;

    const imageUrl = await this.extractImageFromCard(cardUrl);
    if (!imageUrl) return null;

    return {
      imageUrl,
      cardUrl,
      method: 'search',
    };
  }

  private async tryDeterministicImage(setCode: string, cardNumber: string): Promise<string | null> {
    const candidates = [
      `${BASE_URL}/wp-content/uploads/${setCode}_en_${cardNumber}_std.jpg`,
      `${BASE_URL}/wp-content/uploads/${setCode}_en_${cardNumber}_std.jpeg`,
      `${BASE_URL}/wp-content/uploads/${setCode}_en_${cardNumber}_std.png`,
    ];

    for (const url of candidates) {
      if (await urlExists(url)) return url;
    }

    return null;
  }

  private async findCardUrlBySearch(input: PkmnCardsLookupInput): Promise<string | null> {
    const params = new URLSearchParams();
    const terms: string[] = [];

    const name = normalizeName(input.name);
    const setCode = normalizeSetCode(input.setCode);
    const cardNumber = normalizeCardNumber(input.cardNumber);

    if (setCode) terms.push(`e:${setCode}`);
    if (cardNumber) terms.push(`number:${cardNumber}`);
    if (name) terms.push(`name:${slugify(name)}`);

    if (terms.length === 0) return null;

    params.set('s', terms.join(' '));
    params.set('display', 'images');
    params.set('sort', 'date');
    params.set('order', 'asc');

    const searchUrl = `${BASE_URL}/?${params.toString()}`;
    const html = await this.fetchHtml(searchUrl);

    const links = html.match(CARD_LINK_RE) ?? [];
    if (links.length === 0) return null;

    // Pick the first unique card URL from the result page.
    const seen = new Set<string>();
    for (const link of links) {
      const normalized = sanitizeUrl(link);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      return normalized;
    }

    return null;
  }

  private async extractImageFromCard(cardUrl: string): Promise<string | null> {
    if (this.imageByCardUrl.has(cardUrl)) {
      return this.imageByCardUrl.get(cardUrl) ?? null;
    }

    const html = await this.fetchHtml(cardUrl);
    const rawImages = html.match(IMAGE_RE) ?? [];
    for (const raw of rawImages) {
      const imageUrl = sanitizeUrl(raw);
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
}

function normalizeSetCode(setCode: string | null | undefined): string {
  return (setCode ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeCardNumber(cardNumber: string | null | undefined): string {
  const head = (cardNumber ?? '')
    .trim()
    .toLowerCase()
    .split('/')[0]
    .replace(/[^a-z0-9]/g, '');
  return head;
}

function normalizeName(name: string): string {
  return name.trim();
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
