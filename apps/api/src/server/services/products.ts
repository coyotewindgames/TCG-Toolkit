import { and, eq, isNull, sql } from 'drizzle-orm';
import { normalizeToSpacedAlphanumeric, skuIdentityKey } from '@tcg/shared';
import type { CardCondition, CardLanguage, CardPrinting } from '@tcg/shared';
import { schema, type Database } from '../../db/client';
import { BadRequest, NotFound } from '../../common/http-errors';
import { inferSetFromQuery } from './product-search/search-relevance';
import {
  parseProductSearchQuery,
  resolveSearchFilters,
  type ProductSearchArgs,
} from './product-search/search-query-parser';
import { ProductSearchRepository } from './product-search/search-repository';

export class ProductsService {
  private readonly searchRepository: ProductSearchRepository;

  constructor(private readonly db: Database) {
    this.searchRepository = new ProductSearchRepository(db);
  }

  /**
   * Inventory search: parse the request, infer a set from the free-text query,
   * then hand the resolved filters to the repository for the page and facets.
   */
  async search(storeId: string, args: ProductSearchArgs) {
    const query = parseProductSearchQuery(args);
    const normalizedQuery = normalizeToSpacedAlphanumeric(query.rawQuery);
    // Only worth loading the store's set names when there is a query to match.
    const knownSetNames = normalizedQuery
      ? await this.searchRepository.listSetNames(storeId, query.gameFilter)
      : [];
    const inference = inferSetFromQuery(normalizedQuery, knownSetNames);
    const resolved = resolveSearchFilters(query, inference);

    const { results, total } = await this.searchRepository.searchPage(storeId, query, resolved);
    const filters = await this.searchRepository.listFacets(storeId, query, resolved);

    const out = {
      results,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: total > 0 ? Math.ceil(total / query.pageSize) : 1,
      },
      filters,
    };

    if (!query.includeParseDebug) return out;

    return {
      ...out,
      parse: {
        strategy: inference.strategy,
        originalQuery: query.rawQuery,
        normalizedQuery: inference.normalizedQuery,
        inferred: {
          setName: inference.inferredSetName,
          nameQuery: resolved.effectiveNameQuery || null,
        },
        explicit: {
          setName: query.explicitSetFilter || null,
          game: query.gameFilter || null,
          language: query.languageFilter || null,
          rarity: query.rarityFilter || null,
          artist: query.artistFilter || null,
        },
        conflicts: resolved.conflictNotes,
        ambiguousSetCandidates: inference.ambiguousSetCandidates,
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
        gradingCompany: schema.skus.gradingCompany,
        grade: schema.skus.grade,
        certNumber: schema.skus.certNumber,
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
        schema.skus.gradingCompany,
        schema.skus.grade,
        schema.skus.certNumber,
        schema.currentPrices.marketPriceCents,
        schema.currentPrices.sellPriceCents,
      );

    return rows;
  }

  /**
   * Replace the product's image with a caller-supplied data URL and lock the
   * row against automatic re-enrichment. The data URL is stored inline in
   * `image_source_url` (which every read path already handles) so no new
   * serving route is needed.
   */
  async setImageDataUrl(
    storeId: string,
    productId: string,
    dataUrl: string,
  ): Promise<{ imageSourceUrl: string; imageLocked: true }> {
    if (!dataUrl.startsWith('data:image/')) {
      throw BadRequest('Image must be provided as a data:image/... URL.');
    }
    // Data URL bytes ≈ base64 chars × 3/4. Cap at ~750KB decoded (~1MB encoded).
    if (dataUrl.length > 1_050_000) {
      throw BadRequest('Image too large. Please pick something under ~750 KB.');
    }
    const result = await this.db
      .update(schema.products)
      .set({ imageSourceUrl: dataUrl, imageLocked: true, updatedAt: new Date() })
      .where(and(eq(schema.products.storeId, storeId), eq(schema.products.id, productId)))
      .returning({ id: schema.products.id });
    if (result.length === 0) throw NotFound(`product ${productId} not found`);
    return { imageSourceUrl: dataUrl, imageLocked: true };
  }

  /**
   * Clear the product's image and lock the row so the enrichment job doesn't
   * immediately re-populate it with the same (presumably wrong) source URL.
   */
  async clearImage(
    storeId: string,
    productId: string,
  ): Promise<{ imageSourceUrl: null; imageLocked: true }> {
    const result = await this.db
      .update(schema.products)
      .set({ imageSourceUrl: null, imageLocked: true, updatedAt: new Date() })
      .where(and(eq(schema.products.storeId, storeId), eq(schema.products.id, productId)))
      .returning({ id: schema.products.id });
    if (result.length === 0) throw NotFound(`product ${productId} not found`);
    return { imageSourceUrl: null, imageLocked: true };
  }

  /**
   * Create (or reuse) a product + raw SKU straight from a catalog card the
   * operator just scanned but does not yet stock. Mirrors the product/SKU
   * upsert the trade-in flow performs, minus the trade paperwork — the caller
   * receives stock + price separately via InventoryService.receive(). The
   * `tcgapiProductId` is the stable per-store product key; for pkmnprices
   * cards it is the string form of the pkmnprices card id.
   */
  async quickAddSku(
    storeId: string,
    input: {
      tcgapiProductId: string;
      pkmnpricesProductId?: number | null;
      name: string;
      setName?: string | null;
      setId?: string | null;
      cardNumber?: string | null;
      rarity?: string | null;
      imageSourceUrl?: string | null;
      condition: CardCondition;
      printing: CardPrinting;
      language: CardLanguage;
    },
  ): Promise<{ productId: string; skuId: string; skuCreated: boolean }> {
    return this.db.transaction(async (tx) => {
      let [product] = await tx
        .select()
        .from(schema.products)
        .where(
          and(
            eq(schema.products.storeId, storeId),
            eq(schema.products.tcgapiProductId, input.tcgapiProductId),
          ),
        );
      if (!product) {
        [product] = await tx
          .insert(schema.products)
          .values({
            storeId,
            tcgapiProductId: input.tcgapiProductId,
            pkmnpricesProductId: input.pkmnpricesProductId ?? null,
            game: 'pokemon',
            name: input.name,
            setName: input.setName ?? null,
            setId: input.setId ?? null,
            cardNumber: input.cardNumber ?? null,
            rarity: input.rarity ?? null,
            imageSourceUrl: input.imageSourceUrl ?? null,
          })
          .returning();
      }
      if (!product) throw new Error('failed to create product');

      // Backfill an image onto a pre-existing bare product row.
      if (input.imageSourceUrl && !product.imageSourceUrl) {
        await tx
          .update(schema.products)
          .set({ imageSourceUrl: input.imageSourceUrl, updatedAt: new Date() })
          .where(eq(schema.products.id, product.id));
      }

      const [existing] = await tx
        .select({ id: schema.skus.id })
        .from(schema.skus)
        .where(
          and(
            eq(schema.skus.productId, product.id),
            eq(schema.skus.printing, input.printing),
            eq(schema.skus.language, input.language),
            eq(schema.skus.condition, input.condition),
            isNull(schema.skus.gradingCompany),
            isNull(schema.skus.grade),
          ),
        );
      if (existing) return { productId: product.id, skuId: existing.id, skuCreated: false };

      const identity = skuIdentityKey({
        productId: product.id,
        condition: input.condition,
        printing: input.printing,
        language: input.language,
        gradingCompany: null,
        grade: null,
      });
      const skuId = crypto.randomUUID();
      const [created] = await tx
        .insert(schema.skus)
        .values({
          id: skuId,
          productId: product.id,
          storeId,
          condition: input.condition,
          printing: input.printing,
          language: input.language,
          gradingCompany: null,
          grade: null,
          certNumber: null,
          barcode: skuId,
          internalSku: identity,
        })
        .returning({ id: schema.skus.id });
      if (!created) throw new Error('failed to create sku');
      return { productId: product.id, skuId: created.id, skuCreated: true };
    });
  }
}
