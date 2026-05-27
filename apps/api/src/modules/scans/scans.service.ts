import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { ScanResponse } from '@tcg/shared';
import { DRIZZLE } from '../../db/database.module';
import { schema } from '../../db/client';
import type { Database } from '../../db/client';

@Injectable()
export class ScansService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Resolve a barcode to a SKU + product + current price + stock.
   * Used by the register UI on every scan.
   */
  async resolveBarcode(args: { storeId: string; barcode: string }): Promise<ScanResponse> {
    const rows = await this.db
      .select({
        skuId: schema.skus.id,
        productId: schema.products.id,
        name: schema.products.name,
        setName: schema.products.setName,
        cardNumber: schema.products.cardNumber,
        condition: schema.skus.condition,
        printing: schema.skus.printing,
        language: schema.skus.language,
        imageUrl: schema.products.imageCdnUrl,
        sellPriceCents: schema.currentPrices.sellPriceCents,
      })
      .from(schema.skus)
      .innerJoin(schema.products, eq(schema.products.id, schema.skus.productId))
      .leftJoin(schema.currentPrices, eq(schema.currentPrices.skuId, schema.skus.id))
      .where(and(eq(schema.skus.barcode, args.barcode), eq(schema.skus.storeId, args.storeId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new NotFoundException(`unknown barcode: ${args.barcode}`);

    // Aggregate stock across all locations (caller can filter by location later).
    const invRows = await this.db
      .select()
      .from(schema.inventory)
      .where(eq(schema.inventory.skuId, row.skuId));
    const stockOnHand = invRows.reduce((s, r) => s + r.qtyOnHand, 0);
    const stockReserved = invRows.reduce((s, r) => s + r.qtyReserved, 0);

    return {
      skuId: row.skuId,
      productId: row.productId,
      name: row.name,
      setName: row.setName ?? null,
      cardNumber: row.cardNumber ?? null,
      condition: row.condition,
      printing: row.printing,
      language: row.language,
      imageUrl: row.imageUrl ?? null,
      priceCents: row.sellPriceCents ?? 0,
      stockOnHand,
      stockReserved,
    };
  }
}
