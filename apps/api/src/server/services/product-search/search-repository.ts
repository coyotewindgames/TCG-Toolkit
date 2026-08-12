/**
 * All SQL for inventory product search: the grouped result page, its total,
 * and the facet lists. Keeping it here leaves `ProductsService` as a
 * coordinator over parse -> infer -> query.
 */
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../../db/client';
import { tokenVariants } from './search-relevance';
import type { ProductSearchQuery, ResolvedSearchFilters } from './search-query-parser';

/** Cap so a store with thousands of artists doesn't ship them all to the client. */
const ARTIST_FACET_LIMIT = 500;

export interface ProductSearchFacets {
  sets: string[];
  rarities: string[];
  games: string[];
  languages: string[];
  artists: string[];
}

export class ProductSearchRepository {
  constructor(private readonly db: Database) {}

  /** Distinct set names known to the store, optionally narrowed to one game. */
  async listSetNames(storeId: string, gameFilter: string): Promise<string[]> {
    const rows = await this.db
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

    return rows.map((row) => row.value).filter((value): value is string => !!value);
  }

  /** Builds the WHERE clause shared by the result page and every facet query. */
  private rowFilters(storeId: string, query: ProductSearchQuery, resolved: ResolvedSearchFilters) {
    const { effectiveNameQuery, normalizedTokens } = resolved;
    const pattern = `%${effectiveNameQuery}%`;

    const tokenSearchFilters = normalizedTokens.map((token) =>
      or(
        ...tokenVariants(token).map((variant) => {
          const tokenPattern = `%${variant}%`;
          return or(
            ilike(schema.products.name, tokenPattern),
            ilike(schema.products.setName, tokenPattern),
            ilike(schema.products.cardNumber, tokenPattern),
            ilike(schema.products.artist, tokenPattern),
          );
        }),
      ),
    );

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

    return [
      eq(schema.products.storeId, storeId),
      eq(schema.locations.storeId, storeId),
      textSearchFilter,
      resolved.effectiveSetFilter ? eq(schema.products.setName, resolved.effectiveSetFilter) : undefined,
      query.rarityFilter ? eq(schema.products.rarity, query.rarityFilter) : undefined,
      query.gameFilter ? sql`${schema.products.game}::text = ${query.gameFilter}` : undefined,
      query.languageFilter ? sql`${schema.skus.language}::text = ${query.languageFilter}` : undefined,
      query.artistFilter ? eq(schema.products.artist, query.artistFilter) : undefined,
    ].filter(Boolean);
  }

  async searchPage(storeId: string, query: ProductSearchQuery, resolved: ResolvedSearchFilters) {
    const rowFilters = this.rowFilters(storeId, query, resolved);
    const { effectiveNameQuery, effectiveSetFilter } = resolved;

    // Exact name match beats a prefix match, which beats a set match; anything
    // actually on hand gets a small boost so empty shelves sink.
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
        imageLocked: schema.products.imageLocked,
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
        schema.products.imageLocked,
      )
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .as('grouped_products');

    const [countRow] = await this.db.select({ total: sql<number>`count(*)::int` }).from(grouped);

    let orderByClause;
    if (query.sort === 'price_desc') {
      orderByClause = [sql`${grouped.maxSellPriceCents} desc nulls last`, asc(grouped.name)] as const;
    } else if (query.sort === 'price_asc') {
      orderByClause = [sql`${grouped.minSellPriceCents} asc nulls last`, asc(grouped.name)] as const;
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
      .limit(query.pageSize)
      .offset(query.offset);

    return { results, total: countRow?.total ?? 0 };
  }

  /** Facet values that still have at least one on-hand unit under the current filters. */
  async listFacets(
    storeId: string,
    query: ProductSearchQuery,
    resolved: ResolvedSearchFilters,
  ): Promise<ProductSearchFacets> {
    const rowFilters = this.rowFilters(storeId, query, resolved);

    const [setRows, rarityRows, gameRows, languageRows, artistRows] = await Promise.all([
      this.db
        .select({ value: schema.products.setName })
        .from(schema.products)
        .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
        .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
        .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
        .where(and(...rowFilters))
        .groupBy(schema.products.setName)
        .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
        .orderBy(asc(schema.products.setName)),
      this.db
        .select({ value: schema.products.rarity })
        .from(schema.products)
        .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
        .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
        .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
        .where(and(...rowFilters))
        .groupBy(schema.products.rarity)
        .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
        .orderBy(asc(schema.products.rarity)),
      this.db
        .select({ value: schema.products.game })
        .from(schema.products)
        .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
        .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
        .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
        .where(and(...rowFilters))
        .groupBy(schema.products.game)
        .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
        .orderBy(asc(schema.products.game)),
      this.db
        .select({ value: schema.skus.language })
        .from(schema.products)
        .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
        .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
        .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
        .where(and(...rowFilters))
        .groupBy(schema.skus.language)
        .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
        .orderBy(asc(schema.skus.language)),
      this.db
        .select({ value: schema.products.artist })
        .from(schema.products)
        .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
        .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
        .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
        .where(and(...rowFilters, sql`${schema.products.artist} is not null`))
        .groupBy(schema.products.artist)
        .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
        .orderBy(asc(schema.products.artist))
        .limit(ARTIST_FACET_LIMIT),
    ]);

    const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

    return {
      sets: setRows.map((row) => row.value).filter(nonEmpty),
      rarities: rarityRows.map((row) => row.value).filter(nonEmpty),
      games: gameRows.map((row) => String(row.value)).filter((value) => value.trim().length > 0),
      languages: languageRows.map((row) => String(row.value)).filter((value) => value.trim().length > 0),
      artists: artistRows.map((row) => row.value).filter(nonEmpty),
    };
  }
}
