import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { NotFound } from '../../common/http-errors';

type ProductSort = 'name_asc' | 'price_desc' | 'price_asc';

interface SearchInventoryArgs {
  query: string;
  page?: number;
  pageSize?: number;
  sort?: ProductSort;
  setName?: string;
  rarity?: string;
  game?: string;
  language?: string;
  artist?: string;
  includeParseDebug?: boolean;
}

type ParseStrategy = 'plain' | 'set_exact' | 'set_fuzzy';

interface ParsedSearchIntent {
  strategy: ParseStrategy;
  normalizedQuery: string;
  inferredSetName: string | null;
  inferredNameQuery: string;
  ambiguousSetCandidates: string[];
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function trigramSet(value: string): Set<string> {
  const padded = `  ${value}  `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const aTri = trigramSet(a);
  const bTri = trigramSet(b);
  if (aTri.size === 0 || bTri.size === 0) return 0;
  let overlap = 0;
  for (const tri of aTri) {
    if (bTri.has(tri)) overlap += 1;
  }
  return (2 * overlap) / (aTri.size + bTri.size);
}

function removeFirstWholePhrase(source: string, phrase: string): string {
  if (!phrase) return source;
  const srcParts = source.split(' ');
  const phraseParts = phrase.split(' ');
  if (phraseParts.length === 0 || srcParts.length < phraseParts.length) return source;
  for (let i = 0; i <= srcParts.length - phraseParts.length; i += 1) {
    let hit = true;
    for (let j = 0; j < phraseParts.length; j += 1) {
      if (srcParts[i + j] !== phraseParts[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      const remaining = [...srcParts.slice(0, i), ...srcParts.slice(i + phraseParts.length)];
      return remaining.join(' ').trim();
    }
  }
  return source;
}

function tokenVariants(token: string): string[] {
  const normalized = normalizeForMatch(token);
  if (!normalized) return [];
  if (normalized === 'mega') return ['mega', 'm'];
  if (normalized === 'm') return ['m', 'mega'];
  return [normalized];
}

export class ProductsService {
  constructor(private readonly db: Database) {}

  private async parseSearchIntent(
    storeId: string,
    rawQuery: string,
    args: SearchInventoryArgs,
  ): Promise<ParsedSearchIntent> {
    const normalizedQuery = normalizeForMatch(rawQuery);
    if (!normalizedQuery) {
      return {
        strategy: 'plain',
        normalizedQuery,
        inferredSetName: null,
        inferredNameQuery: '',
        ambiguousSetCandidates: [],
      };
    }

    const gameFilter = args.game?.trim() ?? '';
    const setRows = await this.db
      .select({ value: schema.products.setName })
      .from(schema.products)
      .where(
        and(
          eq(schema.products.storeId, storeId),
          gameFilter ? sql`${schema.products.game}::text = ${gameFilter}` : undefined,
          sql`${schema.products.setName} is not null`,
        ),
      )
      .groupBy(schema.products.setName);

    const exactHits = setRows
      .map((r) => r.value)
      .filter((v): v is string => !!v && v.trim().length > 0)
      .map((setName) => ({
        original: setName,
        normalized: normalizeForMatch(setName),
      }))
      .filter((entry) => entry.normalized.length > 0)
      .filter((entry) => ` ${normalizedQuery} `.includes(` ${entry.normalized} `));

    const sortedExact = exactHits.sort((a, b) => b.normalized.length - a.normalized.length);
    if (sortedExact.length > 0) {
      const best = sortedExact[0];
      const sameLength = sortedExact
        .filter((entry) => entry.normalized.length === best.normalized.length)
        .map((entry) => entry.original);
      return {
        strategy: 'set_exact',
        normalizedQuery,
        inferredSetName: best.original,
        inferredNameQuery: removeFirstWholePhrase(normalizedQuery, best.normalized),
        ambiguousSetCandidates: sameLength,
      };
    }

    const fuzzyCandidates = setRows
      .map((r) => r.value)
      .filter((v): v is string => !!v && v.trim().length > 0)
      .map((setName) => {
        const normalized = normalizeForMatch(setName);
        return {
          original: setName,
          normalized,
          score: trigramSimilarity(normalizedQuery, normalized),
        };
      })
      .filter((entry) => entry.normalized.length > 0)
      .sort((a, b) => b.score - a.score || b.normalized.length - a.normalized.length);

    const fuzzyBest = fuzzyCandidates[0];
    if (fuzzyBest && fuzzyBest.score >= 0.42) {
      return {
        strategy: 'set_fuzzy',
        normalizedQuery,
        inferredSetName: fuzzyBest.original,
        inferredNameQuery: normalizedQuery,
        ambiguousSetCandidates: fuzzyCandidates
          .filter((entry) => entry.score >= fuzzyBest.score - 0.02)
          .slice(0, 3)
          .map((entry) => entry.original),
      };
    }

    return {
      strategy: 'plain',
      normalizedQuery,
      inferredSetName: null,
      inferredNameQuery: normalizedQuery,
      ambiguousSetCandidates: [],
    };
  }

  async search(storeId: string, args: SearchInventoryArgs) {
    const trimmed = args.query.trim();
    const page = Number.isFinite(args.page) ? Math.max(1, Number(args.page)) : 1;
    const pageSizeRaw = Number.isFinite(args.pageSize) ? Number(args.pageSize) : 25;
    const pageSize = Math.min(100, Math.max(10, pageSizeRaw));
    const offset = (page - 1) * pageSize;
    const sort: ProductSort = args.sort ?? 'name_asc';
    const explicitSetFilter = args.setName?.trim() ?? '';
    const rarityFilter = args.rarity?.trim() ?? '';
    const gameFilter = args.game?.trim() ?? '';
    const languageFilter = args.language?.trim() ?? '';
    const artistFilter = args.artist?.trim() ?? '';
    const includeParseDebug = !!args.includeParseDebug;
    const parsed = await this.parseSearchIntent(storeId, trimmed, args);
    const inferredSetFilter = explicitSetFilter ? '' : parsed.inferredSetName ?? '';
    const effectiveSetFilter = explicitSetFilter || inferredSetFilter;
    const effectiveNameQuery = (parsed.inferredNameQuery || trimmed).trim();
    const pattern = `%${effectiveNameQuery}%`;
    const normalizedTokens = normalizeForMatch(effectiveNameQuery)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    const tokenSearchFilters = normalizedTokens.map((token) => {
      const variants = tokenVariants(token);
      return or(
        ...variants.map((variant) => {
          const tokenPattern = `%${variant}%`;
          return or(
            ilike(schema.products.name, tokenPattern),
            ilike(schema.products.setName, tokenPattern),
            ilike(schema.products.cardNumber, tokenPattern),
            ilike(schema.products.artist, tokenPattern),
          );
        }),
      );
    });

    const textSearchFilter =
      effectiveNameQuery.length > 0
        ? or(
            ilike(schema.products.name, pattern),
            ilike(schema.products.setName, pattern),
            ilike(schema.products.cardNumber, pattern),
            ilike(schema.products.artist, pattern),
            tokenSearchFilters.length > 0 ? and(...tokenSearchFilters) : undefined,
          )
        : undefined;

    const conflictNotes: string[] = [];
    if (explicitSetFilter && parsed.inferredSetName && explicitSetFilter !== parsed.inferredSetName) {
      conflictNotes.push('explicit set filter overrides inferred set');
    }

    const baseSearchFilters = [
      eq(schema.products.storeId, storeId),
      eq(schema.locations.storeId, storeId),
      textSearchFilter,
    ].filter(Boolean);

    const rowFilters = [
      ...baseSearchFilters,
      effectiveSetFilter ? eq(schema.products.setName, effectiveSetFilter) : undefined,
      rarityFilter ? eq(schema.products.rarity, rarityFilter) : undefined,
      gameFilter ? sql`${schema.products.game}::text = ${gameFilter}` : undefined,
      languageFilter ? sql`${schema.skus.language}::text = ${languageFilter}` : undefined,
      artistFilter ? eq(schema.products.artist, artistFilter) : undefined,
    ].filter(Boolean);

    const rankExpr = sql<number>`(
      case when ${effectiveNameQuery.length > 0} and lower(${schema.products.name}) = lower(${effectiveNameQuery}) then 300 else 0 end
      + case when ${effectiveNameQuery.length > 0} and lower(${schema.products.name}) like lower(${`${effectiveNameQuery}%`}) then 120 else 0 end
      + case when ${effectiveSetFilter.length > 0} and lower(coalesce(${schema.products.setName}, '')) = lower(${effectiveSetFilter}) then 180 else 0 end
      + case when sum(${schema.inventory.qtyOnHand}) > 0 then 40 else 0 end
    )`;

    const grouped = this.db
      .select({
        id: schema.products.id,
        name: schema.products.name,
        setName: schema.products.setName,
        cardNumber: schema.products.cardNumber,
        rarity: schema.products.rarity,
        artist: schema.products.artist,
        imageSourceUrl: schema.products.imageSourceUrl,
        availableQty:
          sql<number>`coalesce(sum(${schema.inventory.qtyOnHand}), 0)::int`.as('available_qty'),
        minSellPriceCents:
          sql<number | null>`min(coalesce(${schema.currentPrices.marketPriceCents}, ${schema.currentPrices.sellPriceCents}))`.as('min_sell_price_cents'),
        maxSellPriceCents:
          sql<number | null>`max(coalesce(${schema.currentPrices.marketPriceCents}, ${schema.currentPrices.sellPriceCents}))`.as('max_sell_price_cents'),
        // Total dollars we paid for the units currently on hand:
        //   sum(qty_on_hand * cost_avg_cents)
        totalCostBasisCents:
          sql<number>`coalesce(sum(${schema.inventory.qtyOnHand} * ${schema.inventory.costAvgCents}), 0)::int`.as(
            'total_cost_basis_cents',
          ),
        // Weighted-average cost per unit across all on-hand inventory rows.
        avgCostCents:
          sql<number | null>`case when sum(${schema.inventory.qtyOnHand}) > 0
            then (sum(${schema.inventory.qtyOnHand} * ${schema.inventory.costAvgCents})::float / nullif(sum(${schema.inventory.qtyOnHand}), 0))::int
            else null end`.as('avg_cost_cents'),
        rankScore: rankExpr.as('rank_score'),
      })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.currentPrices, eq(schema.currentPrices.skuId, schema.skus.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(and(...rowFilters))
      .groupBy(
        schema.products.id,
        schema.products.name,
        schema.products.setName,
        schema.products.cardNumber,
        schema.products.rarity,
        schema.products.artist,
        schema.products.imageSourceUrl,
      )
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .as('grouped_products');

    const [countRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(grouped);
    const total = countRow?.total ?? 0;

    let orderByClause;
    if (sort === 'price_desc') {
      orderByClause = [
        sql`${grouped.maxSellPriceCents} desc nulls last`,
        asc(grouped.name),
      ] as const;
    } else if (sort === 'price_asc') {
      orderByClause = [
        sql`${grouped.minSellPriceCents} asc nulls last`,
        asc(grouped.name),
      ] as const;
    } else {
      orderByClause =
        effectiveNameQuery.length > 0
          ? ([sql`${grouped.rankScore} desc`, asc(grouped.name)] as const)
          : ([asc(grouped.name)] as const);
    }

    const results = await this.db
      .select()
      .from(grouped)
      .orderBy(...orderByClause)
      .limit(pageSize)
      .offset(offset);

    const setRows = await this.db
      .select({ value: schema.products.setName })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(and(...rowFilters))
      .groupBy(schema.products.setName)
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .orderBy(asc(schema.products.setName));

    const rarityRows = await this.db
      .select({ value: schema.products.rarity })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(and(...rowFilters))
      .groupBy(schema.products.rarity)
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .orderBy(asc(schema.products.rarity));

    const gameRows = await this.db
      .select({ value: schema.products.game })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(and(...rowFilters))
      .groupBy(schema.products.game)
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .orderBy(asc(schema.products.game));

    const languageRows = await this.db
      .select({ value: schema.skus.language })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(and(...rowFilters))
      .groupBy(schema.skus.language)
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .orderBy(asc(schema.skus.language));

    // Distinct artists with at least one on-hand unit matching the current
    // filters. Facet is capped so we don't ship 5k+ names to the client.
    const artistRows = await this.db
      .select({ value: schema.products.artist })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(and(...rowFilters, sql`${schema.products.artist} is not null`))
      .groupBy(schema.products.artist)
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .orderBy(asc(schema.products.artist))
      .limit(500);

    const out = {
      results,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total > 0 ? Math.ceil(total / pageSize) : 1,
      },
      filters: {
        sets: setRows.map((r) => r.value).filter((v): v is string => !!v && v.trim().length > 0),
        rarities: rarityRows
          .map((r) => r.value)
          .filter((v): v is string => !!v && v.trim().length > 0),
        games: gameRows
          .map((r) => String(r.value))
          .filter((v) => v.trim().length > 0),
        languages: languageRows
          .map((r) => String(r.value))
          .filter((v) => v.trim().length > 0),
        artists: artistRows
          .map((r) => r.value)
          .filter((v): v is string => !!v && v.trim().length > 0),
      },
    };

    if (includeParseDebug) {
      return {
        ...out,
        parse: {
          strategy: parsed.strategy,
          originalQuery: trimmed,
          normalizedQuery: parsed.normalizedQuery,
          inferred: {
            setName: parsed.inferredSetName,
            nameQuery: effectiveNameQuery || null,
          },
          explicit: {
            setName: explicitSetFilter || null,
            game: gameFilter || null,
            language: languageFilter || null,
            rarity: rarityFilter || null,
            artist: artistFilter || null,
          },
          conflicts: conflictNotes,
          ambiguousSetCandidates: parsed.ambiguousSetCandidates,
        },
      };
    }

    return out;
  }

  async findById(storeId: string, productId: string) {
    const [row] = await this.db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.storeId, storeId), eq(schema.products.id, productId)))
      .limit(1);
    if (!row) throw NotFound(`product ${productId} not found`);
    return row;
  }

  async listSkus(storeId: string, productId: string) {
    const rows = await this.db
      .select({
        id: schema.skus.id,
        barcode: schema.skus.barcode,
        condition: schema.skus.condition,
        printing: schema.skus.printing,
        language: schema.skus.language,
        marketPriceCents: schema.currentPrices.marketPriceCents,
        sellPriceCents: schema.currentPrices.sellPriceCents,
        availableQty:
          sql<number>`coalesce(sum(${schema.inventory.qtyOnHand}), 0)::int`.as('available_qty'),
        // Weighted-average cost across all locations that hold this SKU.
        avgCostCents:
          sql<number | null>`case when sum(${schema.inventory.qtyOnHand}) > 0
            then (sum(${schema.inventory.qtyOnHand} * ${schema.inventory.costAvgCents})::float / nullif(sum(${schema.inventory.qtyOnHand}), 0))::int
            else null end`.as('avg_cost_cents'),
        totalCostBasisCents:
          sql<number>`coalesce(sum(${schema.inventory.qtyOnHand} * ${schema.inventory.costAvgCents}), 0)::int`.as(
            'total_cost_basis_cents',
          ),
      })
      .from(schema.skus)
      .leftJoin(schema.currentPrices, eq(schema.currentPrices.skuId, schema.skus.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .leftJoin(
        schema.locations,
        and(
          eq(schema.locations.id, schema.inventory.locationId),
          eq(schema.locations.storeId, storeId),
        ),
      )
      .where(and(eq(schema.skus.storeId, storeId), eq(schema.skus.productId, productId)))
      .groupBy(
        schema.skus.id,
        schema.skus.barcode,
        schema.skus.condition,
        schema.skus.printing,
        schema.skus.language,
        schema.currentPrices.marketPriceCents,
        schema.currentPrices.sellPriceCents,
      );

    return rows;
  }
}
