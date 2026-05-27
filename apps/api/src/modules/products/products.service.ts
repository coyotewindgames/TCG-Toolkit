import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../db/database.module';
import type { Database } from '../../db/client';
import { schema } from '../../db/client';

@Injectable()
export class ProductsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

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
    if (!row) throw new NotFoundException(`product ${productId} not found`);
    return row;
  }

  /**
   * Full-text search via the generated `search_tsv` column.
   * Falls back to ILIKE if the tsvector column hasn't been populated.
   */
  async fullTextSearch(storeId: string, query: string, limit = 25) {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const tsQuery = trimmed
      .split(/\s+/)
      .map((t) => `${t}:*`)
      .join(' & ');
    return this.db
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.storeId, storeId),
          sql`search_tsv @@ to_tsquery('simple', ${tsQuery})`,
        ),
      )
      .limit(limit);
  }
}
