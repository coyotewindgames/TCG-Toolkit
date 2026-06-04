import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import type { ConfigService } from './config-service';
import { TcgapiClient, type TcgapiCard, type TcgapiSet } from '../../integrations/tcgapi/client';
import { BadRequest } from '../../common/http-errors';

interface TcgapiSetEntry extends TcgapiSet {
  /** Pre-normalized name for fast comparison. */
  normName: string;
}

/**
 * Internal `gameEnum` value → tcgapi.dev `game` query string.
 * Anything not listed is sent through unchanged.
 */
const GAME_SLUG: Record<string, string | undefined> = {
  mtg: 'magic-the-gathering',
  pokemon: 'pokemon',
  yugioh: 'yugioh',
  lorcana: 'disney-lorcana',
  one_piece: 'one-piece-card-game',
  flesh_and_blood: 'flesh-and-blood',
  sealed: undefined,
  supplies: undefined,
  other: undefined,
};

export interface EnrichMatched {
  productId: string;
  name: string;
  setName: string | null;
  cardNumber: string | null;
  imageSourceUrl: string | null;
  tcgapiProductId: string;
}

export interface EnrichResult {
  scanned: number;
  matched: number;
  imagesUpdated: number;
  matches: EnrichMatched[];
  unmatched: Array<{ productId: string; name: string; reason: string }>;
  remaining: number;
}

/** Hard-coded batch size for every enrichment run. Conservative because the
 * tcgapi.dev free tier currently allows only 100 requests/day. */
export const ENRICH_BATCH_SIZE = 10;

/**
 * In-memory set of (storeId, scope) tuples currently being processed by a
 * background runner. Prevents the same scope from being kicked off twice.
 */
const BACKGROUND_RUNS = new Set<string>();

export class CatalogEnrichmentService {
  /**
   * Process-lifetime caches of tcgapi.dev catalog data. The free tier is
   * capped at 100 requests/day, so once we've fetched a game's set list or
   * a set's full card roster we keep reusing it across batches/imports.
   */
  private readonly setsByGame = new Map<string, TcgapiSetEntry[]>();
  private readonly cardsBySet = new Map<string, TcgapiCard[]>();

  constructor(
    private readonly db: Database,
    private readonly configs: ConfigService,
  ) {}

  async enrichStore(args: {
    storeId: string;
    onlyMissingImage?: boolean;
  }): Promise<EnrichResult> {
    const limit = ENRICH_BATCH_SIZE;

    const status = await this.configs.getTcgapiStatus(args.storeId);
    if (!status.configured || !status.hasKey) {
      throw BadRequest('TCGapi.dev is not configured for this store. Set it up in Settings first.');
    }
    const tcg = await this.configs.getTcgapi(args.storeId);
    const client = new TcgapiClient({ baseUrl: tcg.baseUrl, apiKey: tcg.apiKey });

    // Pick products that still need enrichment. Either no tcgapi mapping yet,
    // or (if onlyMissingImage) just no image. Skip games where tcgapi has no
    // catalogue (sealed/supplies/other).
    const where = and(
      eq(schema.products.storeId, args.storeId),
      sql`${schema.products.game} not in ('sealed','supplies','other')`,
      args.onlyMissingImage
        ? or(
            isNull(schema.products.imageSourceUrl),
            eq(schema.products.imageSourceUrl, ''),
          )
        : or(
            isNull(schema.products.tcgapiProductId),
            isNull(schema.products.imageSourceUrl),
          ),
    );

    const candidates = await this.db
      .select({
        id: schema.products.id,
        name: schema.products.name,
        setName: schema.products.setName,
        cardNumber: schema.products.cardNumber,
        game: schema.products.game,
        tcgapiProductId: schema.products.tcgapiProductId,
        imageSourceUrl: schema.products.imageSourceUrl,
      })
      .from(schema.products)
      .where(where)
      .limit(limit);

    const remainingRows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.products)
      .where(where);
    const totalToDo = Number(remainingRows[0]?.n ?? 0);

    const result: EnrichResult = {
      scanned: candidates.length,
      matched: 0,
      imagesUpdated: 0,
      matches: [],
      unmatched: [],
      remaining: Math.max(0, totalToDo - candidates.length),
    };

    for (const p of candidates) {
      try {
        const match = await this.findBestMatch(client, p);
        if (!match) {
          result.unmatched.push({ productId: p.id, name: p.name, reason: 'no match' });
          await sleep(60);
          continue;
        }

        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (!p.tcgapiProductId) patch.tcgapiProductId = match.id;
        const newImage = match.imageUrl && !p.imageSourceUrl ? match.imageUrl : null;
        if (newImage) {
          patch.imageSourceUrl = newImage;
          result.imagesUpdated++;
        }
        if (Object.keys(patch).length > 1) {
          await this.db
            .update(schema.products)
            .set(patch)
            .where(eq(schema.products.id, p.id));
          result.matched++;
          result.matches.push({
            productId: p.id,
            name: p.name,
            setName: p.setName,
            cardNumber: p.cardNumber,
            imageSourceUrl: newImage ?? p.imageSourceUrl ?? null,
            tcgapiProductId: match.id,
          });
        }
      } catch (err) {
        result.unmatched.push({
          productId: p.id,
          name: p.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(60); // gentle rate limit
    }

    return result;
  }

  /**
   * Fire-and-forget loop that drains all enrichment work in batches of
   * `ENRICH_BATCH_SIZE`. Errors are swallowed (logged) so callers can
   * trigger this without awaiting.
   */
  runInBackground(args: { storeId: string; onlyMissingImage?: boolean }): void {
    const key = `${args.storeId}:${args.onlyMissingImage ? 'img' : 'all'}`;
    if (BACKGROUND_RUNS.has(key)) return; // already running for this scope
    BACKGROUND_RUNS.add(key);
    void (async () => {
      try {
        for (let i = 0; i < 1000; i++) {
          const r = await this.enrichStore(args);
          if (r.remaining === 0 || r.scanned === 0) return;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[enrichment] background batch failed', err);
      } finally {
        BACKGROUND_RUNS.delete(key);
      }
    })();
  }

  isRunning(args: { storeId: string; onlyMissingImage?: boolean }): boolean {
    return BACKGROUND_RUNS.has(`${args.storeId}:${args.onlyMissingImage ? 'img' : 'all'}`);
  }

  /** Count of products that still need enrichment under the given filter. */
  async pendingCount(args: {
    storeId: string;
    onlyMissingImage?: boolean;
  }): Promise<number> {
    const where = and(
      eq(schema.products.storeId, args.storeId),
      sql`${schema.products.game} not in ('sealed','supplies','other')`,
      args.onlyMissingImage
        ? or(isNull(schema.products.imageSourceUrl), eq(schema.products.imageSourceUrl, ''))
        : or(
            isNull(schema.products.tcgapiProductId),
            isNull(schema.products.imageSourceUrl),
          ),
    );
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.products)
      .where(where);
    return Number(row?.n ?? 0);
  }

  private async findBestMatch(
    client: TcgapiClient,
    p: {
      name: string;
      setName: string | null;
      cardNumber: string | null;
      game: string;
    },
  ): Promise<TcgapiCard | null> {
    const game = GAME_SLUG[p.game] ?? p.game;

    // Strategy: try to resolve the *set* first, then look up the card by
    // number inside that set's cached roster. Only fall back to free-text
    // /search if we can't identify the set or the card isn't in it. This
    // is dramatically more accurate AND cheaper than search-per-card,
    // because once a set is cached every product in that set is free.
    const setEntry = p.setName ? await this.resolveSet(client, game, p.setName) : null;
    if (setEntry) {
      const cards = await this.getSetCards(client, setEntry.id);
      const direct = matchCardInSet(cards, p.name, p.cardNumber);
      if (direct) return direct;
    }

    // Fallback: targeted search. Pass set_id when we have one to drastically
    // narrow the result space; otherwise use a name-only query (the API
    // matches against `clean_name`, so adding numbers/set names actually
    // hurts recall).
    const q = p.name;
    const page = await client.search({
      q,
      game,
      setId: setEntry?.id,
      perPage: 25,
    });
    if (!page.results.length) return null;

    const wantName = norm(p.name);
    const wantNum = normNum(p.cardNumber);
    const wantSet = p.setName ? norm(p.setName) : null;

    let best: { card: TcgapiCard; score: number } | null = null;
    for (const c of page.results) {
      let score = 0;
      const cName = norm(c.name);
      if (cName === wantName) score += 5;
      else if (cName.includes(wantName) || wantName.includes(cName)) score += 2;

      if (wantNum && c.number) {
        const cNum = normNum(c.number);
        if (cNum && cNum === wantNum) score += 4;
        else if (cNum && (cNum.endsWith(wantNum) || wantNum.endsWith(cNum))) score += 2;
      }

      if (wantSet && c.setName) {
        const cSet = norm(c.setName);
        if (cSet === wantSet) score += 3;
        else if (cSet.includes(wantSet) || wantSet.includes(cSet)) score += 1;
      }

      if (c.imageUrl) score += 1;

      if (!best || score > best.score) best = { card: c, score };
    }

    if (!best || best.score < 5) return null;
    return best.card;
  }

  /**
   * Resolve a Collectr-style set name to a tcgapi.dev set id, caching the
   * full set list per game on first call. Handles common formatting
   * differences ("Generations: Radiant Collection", parentheticals, etc.).
   */
  private async resolveSet(
    client: TcgapiClient,
    gameSlug: string,
    setName: string,
  ): Promise<TcgapiSetEntry | null> {
    let sets = this.setsByGame.get(gameSlug);
    if (!sets) {
      const fetched = await client.listSetsByGame(gameSlug);
      sets = fetched.map((s) => ({ ...s, normName: norm(s.name) }));
      this.setsByGame.set(gameSlug, sets);
    }
    const want = norm(setName);
    if (!want) return null;

    // Exact normalized match.
    let hit = sets.find((s) => s.normName === want);
    if (hit) return hit;

    // Sub-set notation: "Generations: Radiant Collection" → try the suffix
    // ("Radiant Collection") then the prefix ("Generations").
    const colonParts = setName.split(':').map((s) => s.trim()).filter(Boolean);
    if (colonParts.length > 1) {
      for (const part of [colonParts[colonParts.length - 1], colonParts[0]]) {
        const want2 = norm(part);
        hit = sets.find((s) => s.normName === want2);
        if (hit) return hit;
      }
    }

    // Strip parentheticals: "Base Set (Unlimited)" → "Base Set".
    const noParens = setName.replace(/\([^)]*\)/g, '').trim();
    if (noParens && noParens !== setName) {
      const want3 = norm(noParens);
      hit = sets.find((s) => s.normName === want3);
      if (hit) return hit;
    }

    // Last-ditch substring match (only safe when our string is reasonably
    // long, otherwise "Promo" would match dozens of sets).
    if (want.length >= 8) {
      hit = sets.find((s) => s.normName.includes(want) || want.includes(s.normName));
      if (hit) return hit;
    }
    return null;
  }

  private async getSetCards(client: TcgapiClient, setId: string): Promise<TcgapiCard[]> {
    let cards = this.cardsBySet.get(setId);
    if (!cards) {
      cards = await client.listCardsInSet(setId);
      this.cardsBySet.set(setId, cards);
    }
    return cards;
  }
}

/**
 * Match a Collectr product against a fully-loaded set roster. We try number
 * first (very high signal) and fall back to name. Returns null on no match.
 */
function matchCardInSet(
  cards: TcgapiCard[],
  cardName: string,
  cardNumber: string | null,
): TcgapiCard | null {
  const wantName = norm(cardName);
  const wantNum = normNum(cardNumber);

  if (wantNum) {
    const byNumber = cards.filter((c) => c.number && normNum(c.number) === wantNum);
    if (byNumber.length === 1) return byNumber[0];
    if (byNumber.length > 1) {
      // Same number can have variants (e.g. "Pikachu" vs "Pikachu Promo");
      // disambiguate by name.
      const tied = byNumber.find((c) => norm(c.name) === wantName);
      if (tied) return tied;
      const partial = byNumber.find(
        (c) => norm(c.name).includes(wantName) || wantName.includes(norm(c.name)),
      );
      if (partial) return partial;
      // Couldn't disambiguate — prefer the one with an image.
      return byNumber.find((c) => c.imageUrl) ?? byNumber[0];
    }
  }

  // No number match — try name within this set.
  const byName = cards.filter((c) => norm(c.name) === wantName);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return byName.find((c) => c.imageUrl) ?? byName[0];
  return null;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Normalize a card number for comparison:
 *   - drop everything after the first slash ("022/217" → "022", "GG36/GG70" → "gg36")
 *   - lowercase + strip non-alphanumeric
 *   - if purely numeric, strip leading zeros so "022" matches "22"
 */
function normNum(v: string | null | undefined): string {
  if (!v) return '';
  const head = v.split('/')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^\d+$/.test(head) ? String(parseInt(head, 10)) : head;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
