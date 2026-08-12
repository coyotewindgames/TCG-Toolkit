/** Endpoints, scraping regexes and request headers for pkmncards.com. */

export const BASE_URL = 'https://pkmncards.com';
export const ARTIST_SITEMAP_URL = `${BASE_URL}/pkmn_artist-sitemap.xml`;
export const CARD_HREF_RE = /href=["']([^"']*\/card\/[^"']+)["']/gi;
export const SET_HREF_RE = /href=["']([^"']*\/set\/[^"']+\/)["'][^>]*>([^<]+)<\/a>/gi;
export const IMAGE_RE = /(?:https?:\/\/pkmncards\.com)?\/wp-content\/uploads\/[^"'\s<>]+\.(?:jpg|jpeg|png)/gi;
export const ARTIST_URL_RE = /<loc>\s*(https?:\/\/pkmncards\.com\/artist\/([^/<]+)\/)\s*<\/loc>/gi;
/** `{name-slug}-{set-slug}-{set-code}-{number}` — code is 1–5 lowercase alpha. */
export const CARD_URL_TAIL_RE = /^(?<head>.+)-(?<code>[a-z]{1,5})-(?<number>[a-z0-9]+)$/i;

export const REQUEST_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml',
  'user-agent': 'TCG-Toolkit/1.0 (+inventory image enrichment)',
};
