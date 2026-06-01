import { and, eq, ilike, or } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { NotFound } from '../../common/http-errors';

export class ProductsService {
  constructor(private readonly db: Database) {}

  async search(storeId: string, query: string, limit = 25) {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const pattern = `%${trimmed}%`;
    return this.db
      .select()
      .from(schema.products)
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
}
