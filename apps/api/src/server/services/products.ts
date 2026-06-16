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
}

export class ProductsService {
  constructor(private readonly db: Database) {}

  async search(storeId: string, args: SearchInventoryArgs) {
    const trimmed = args.query.trim();
    const page = Number.isFinite(args.page) ? Math.max(1, Number(args.page)) : 1;
    const pageSizeRaw = Number.isFinite(args.pageSize) ? Number(args.pageSize) : 25;
    const pageSize = Math.min(100, Math.max(10, pageSizeRaw));
    const offset = (page - 1) * pageSize;
    const sort: ProductSort = args.sort ?? 'name_asc';
    const setFilter = args.setName?.trim() ?? '';
    const rarityFilter = args.rarity?.trim() ?? '';
    const pattern = `%${trimmed}%`;

    const baseSearchFilters = [
      eq(schema.products.storeId, storeId),
      eq(schema.locations.storeId, storeId),
      trimmed
        ? or(
            ilike(schema.products.name, pattern),
            ilike(schema.products.setName, pattern),
            ilike(schema.products.cardNumber, pattern),
          )
        : undefined,
    ].filter(Boolean);

    const rowFilters = [
      ...baseSearchFilters,
      setFilter ? eq(schema.products.setName, setFilter) : undefined,
      rarityFilter ? eq(schema.products.rarity, rarityFilter) : undefined,
    ].filter(Boolean);

    const grouped = this.db
      .select({
        id: schema.products.id,
        name: schema.products.name,
        setName: schema.products.setName,
        cardNumber: schema.products.cardNumber,
        rarity: schema.products.rarity,
        imageSourceUrl: schema.products.imageSourceUrl,
        availableQty:
          sql<number>`coalesce(sum(${schema.inventory.qtyOnHand}), 0)::int`.as('available_qty'),
        minSellPriceCents:
          sql<number | null>`min(${schema.currentPrices.sellPriceCents})`.as('min_sell_price_cents'),
        maxSellPriceCents:
          sql<number | null>`max(${schema.currentPrices.sellPriceCents})`.as('max_sell_price_cents'),
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
      orderByClause = [asc(grouped.name)] as const;
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
      .where(and(...baseSearchFilters))
      .groupBy(schema.products.setName)
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .orderBy(asc(schema.products.setName));

    const rarityRows = await this.db
      .select({ value: schema.products.rarity })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.inventory, eq(schema.inventory.skuId, schema.skus.id))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventory.locationId))
      .where(and(...baseSearchFilters))
      .groupBy(schema.products.rarity)
      .having(sql`sum(${schema.inventory.qtyOnHand}) > 0`)
      .orderBy(asc(schema.products.rarity));

    return {
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
      },
    };
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
        sellPriceCents: schema.currentPrices.sellPriceCents,
        availableQty:
          sql<number>`coalesce(sum(${schema.inventory.qtyOnHand}), 0)::int`.as('available_qty'),
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
        schema.currentPrices.sellPriceCents,
      );

    return rows;
  }
}
