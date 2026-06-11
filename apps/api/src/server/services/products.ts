import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { NotFound } from '../../common/http-errors';

export class ProductsService {
  constructor(private readonly db: Database) {}

  async search(storeId: string, query: string, limit = 25) {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const pattern = `%${trimmed}%`;
    return this.db
      .select({
        id: schema.products.id,
        name: schema.products.name,
        setName: schema.products.setName,
        cardNumber: schema.products.cardNumber,
        rarity: schema.products.rarity,
        imageSourceUrl: schema.products.imageSourceUrl,
        minSellPriceCents:
          sql<number | null>`min(${schema.currentPrices.sellPriceCents})`.as('min_sell_price_cents'),
        maxSellPriceCents:
          sql<number | null>`max(${schema.currentPrices.sellPriceCents})`.as('max_sell_price_cents'),
      })
      .from(schema.products)
      .leftJoin(schema.skus, eq(schema.skus.productId, schema.products.id))
      .leftJoin(schema.currentPrices, eq(schema.currentPrices.skuId, schema.skus.id))
      .where(
        and(
          eq(schema.products.storeId, storeId),
          or(
            ilike(schema.products.name, pattern),
            ilike(schema.products.setName, pattern),
            ilike(schema.products.cardNumber, pattern),
          ),
        ),
      )
      .groupBy(
        schema.products.id,
        schema.products.name,
        schema.products.setName,
        schema.products.cardNumber,
        schema.products.rarity,
        schema.products.imageSourceUrl,
      )
      .limit(limit);
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
      })
      .from(schema.skus)
      .leftJoin(schema.currentPrices, eq(schema.currentPrices.skuId, schema.skus.id))
      .where(and(eq(schema.skus.storeId, storeId), eq(schema.skus.productId, productId)));

    return rows;
  }
}
