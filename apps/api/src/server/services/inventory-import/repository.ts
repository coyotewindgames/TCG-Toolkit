/**
 * The only place the inventory import talks SQL. Keeping every query here lets
 * the service be exercised with an in-memory fake instead of a live Postgres.
 */
import { and, eq, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../../db/client';
import type {
  Condition,
  CurrentPricePayload,
  Game,
  InventoryWithCostPayload,
  InventoryWithoutCostPayload,
  Language,
  Printing,
  ProductCandidate,
  SkuCandidate,
} from './types';

/** The subset of the Drizzle handle used here; also satisfied by a transaction. */
export type TransactionalDatabase = Pick<Database, 'select' | 'insert'>;

export interface ProductIdentityRow {
  id: string;
  game: Game;
  name: string;
  setName: string | null;
  cardNumber: string | null;
}

export interface SkuIdentityRow {
  id: string;
  productId: string;
  /** Nullable in the schema: graded SKUs carry a grade instead of a condition. */
  condition: Condition | null;
  printing: Printing;
  language: Language;
}

export interface ImportWarmupRows {
  products: ProductIdentityRow[];
  skus: SkuIdentityRow[];
  inventorySkuIds: string[];
  pricedSkuIds: string[];
}

export class InventoryImportRepository {
  constructor(private readonly db: TransactionalDatabase) {}

  /** Repository bound to `tx`, for use inside a transaction callback. */
  static forTransaction(tx: TransactionalDatabase): InventoryImportRepository {
    return new InventoryImportRepository(tx);
  }

  async findLocationInStore(storeId: string, locationId: string): Promise<{ id: string } | undefined> {
    const [location] = await this.db
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.id, locationId), eq(schema.locations.storeId, storeId)))
      .limit(1);
    return location;
  }

  /**
   * Loads the existing product/SKU/inventory/price identities for a store in
   * four bulk queries so the per-row loop can hit memory instead of the DB.
   */
  async loadExistingIdentities(storeId: string, locationId: string): Promise<ImportWarmupRows> {
    const [products, skus, inventoryRows, pricedRows] = await Promise.all([
      this.db
        .select({
          id: schema.products.id,
          game: schema.products.game,
          name: schema.products.name,
          setName: schema.products.setName,
          cardNumber: schema.products.cardNumber,
        })
        .from(schema.products)
        .where(eq(schema.products.storeId, storeId)),
      this.db
        .select({
          id: schema.skus.id,
          productId: schema.skus.productId,
          condition: schema.skus.condition,
          printing: schema.skus.printing,
          language: schema.skus.language,
        })
        .from(schema.skus)
        .where(eq(schema.skus.storeId, storeId)),
      this.db
        .select({ skuId: schema.inventory.skuId })
        .from(schema.inventory)
        .where(eq(schema.inventory.locationId, locationId)),
      this.db
        .select({ skuId: schema.currentPrices.skuId })
        .from(schema.currentPrices)
        .innerJoin(schema.skus, eq(schema.currentPrices.skuId, schema.skus.id))
        .where(eq(schema.skus.storeId, storeId)),
    ]);

    return {
      products,
      skus,
      inventorySkuIds: inventoryRows.map((row) => row.skuId),
      pricedSkuIds: pricedRows.map((row) => row.skuId),
    };
  }

  async insertProducts(storeId: string, candidates: ProductCandidate[]): Promise<ProductIdentityRow[]> {
    return this.db
      .insert(schema.products)
      .values(
        candidates.map((candidate) => ({
          storeId,
          game: candidate.game,
          name: candidate.name,
          setName: candidate.setName,
          setId: candidate.setCode,
          cardNumber: candidate.cardNumber,
          rarity: candidate.rarity,
        })),
      )
      .onConflictDoNothing()
      .returning({
        id: schema.products.id,
        game: schema.products.game,
        name: schema.products.name,
        setName: schema.products.setName,
        cardNumber: schema.products.cardNumber,
      });
  }

  /** Looks up products that already existed and were therefore not returned by the insert. */
  async findProductsByIdentity(storeId: string, candidates: ProductCandidate[]): Promise<ProductIdentityRow[]> {
    const predicates = candidates.map((candidate) =>
      and(
        eq(schema.products.storeId, storeId),
        eq(schema.products.game, candidate.game),
        eq(schema.products.name, candidate.name),
        sql`coalesce(${schema.products.setName}, '') = ${candidate.setName ?? ''}`,
        sql`coalesce(${schema.products.cardNumber}, '') = ${candidate.cardNumber ?? ''}`,
      ),
    );

    return this.db
      .select({
        id: schema.products.id,
        game: schema.products.game,
        name: schema.products.name,
        setName: schema.products.setName,
        cardNumber: schema.products.cardNumber,
      })
      .from(schema.products)
      .where(predicates.length === 1 ? predicates[0] : or(...predicates));
  }

  async insertSkus(storeId: string, candidates: SkuCandidate[]): Promise<SkuIdentityRow[]> {
    return this.db
      .insert(schema.skus)
      .values(
        candidates.map((candidate) => ({
          id: candidate.id,
          storeId,
          productId: candidate.productId,
          condition: candidate.condition,
          printing: candidate.printing,
          language: candidate.language,
          barcode: candidate.id,
          internalSku: candidate.id,
        })),
      )
      .onConflictDoNothing()
      .returning({
        id: schema.skus.id,
        productId: schema.skus.productId,
        condition: schema.skus.condition,
        printing: schema.skus.printing,
        language: schema.skus.language,
      });
  }

  /** Looks up SKUs that already existed and were therefore not returned by the insert. */
  async findSkusByIdentity(candidates: SkuCandidate[]): Promise<SkuIdentityRow[]> {
    const predicates = candidates.map((candidate) =>
      and(
        eq(schema.skus.productId, candidate.productId),
        eq(schema.skus.condition, candidate.condition),
        eq(schema.skus.printing, candidate.printing),
        eq(schema.skus.language, candidate.language),
      ),
    );

    return this.db
      .select({
        id: schema.skus.id,
        productId: schema.skus.productId,
        condition: schema.skus.condition,
        printing: schema.skus.printing,
        language: schema.skus.language,
      })
      .from(schema.skus)
      .where(predicates.length === 1 ? predicates[0] : or(...predicates));
  }

  /** Adds quantity and rolls the weighted-average cost forward. */
  async upsertInventoryWithCost(rows: InventoryWithCostPayload[]): Promise<void> {
    if (!rows.length) return;

    await this.db
      .insert(schema.inventory)
      .values(
        rows.map((row) => ({
          skuId: row.skuId,
          locationId: row.locationId,
          qtyOnHand: row.qty,
          qtyReserved: 0,
          costAvgCents: row.weightedCostCents,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.inventory.skuId, schema.inventory.locationId],
        set: {
          qtyOnHand: sql`${schema.inventory.qtyOnHand} + excluded.qty_on_hand`,
          costAvgCents: sql`case
              when ${schema.inventory.qtyOnHand} + excluded.qty_on_hand = 0 then 0::int
              else round(
                (${schema.inventory.costAvgCents} * ${schema.inventory.qtyOnHand} + excluded.cost_avg_cents * excluded.qty_on_hand)
                / (${schema.inventory.qtyOnHand} + excluded.qty_on_hand)
              )::int
            end`,
          updatedAt: new Date(),
        },
      });
  }

  /** Adds quantity only, leaving any existing average cost untouched. */
  async upsertInventoryWithoutCost(rows: InventoryWithoutCostPayload[]): Promise<void> {
    if (!rows.length) return;

    await this.db
      .insert(schema.inventory)
      .values(
        rows.map((row) => ({
          skuId: row.skuId,
          locationId: row.locationId,
          qtyOnHand: row.qty,
          qtyReserved: 0,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.inventory.skuId, schema.inventory.locationId],
        set: {
          qtyOnHand: sql`${schema.inventory.qtyOnHand} + excluded.qty_on_hand`,
          updatedAt: new Date(),
        },
      });
  }

  async upsertCurrentPrices(rows: CurrentPricePayload[]): Promise<void> {
    if (!rows.length) return;

    await this.db
      .insert(schema.currentPrices)
      .values(
        rows.map((row) => ({
          skuId: row.skuId,
          sellPriceCents: row.marketCents,
          buyPriceCents: Math.round(row.marketCents * 0.5),
          marketPriceCents: row.marketCents,
        })),
      )
      .onConflictDoUpdate({
        target: schema.currentPrices.skuId,
        set: {
          sellPriceCents: sql`excluded.sell_price_cents`,
          buyPriceCents: sql`excluded.buy_price_cents`,
          marketPriceCents: sql`excluded.market_price_cents`,
          updatedAt: new Date(),
        },
      });
  }
}
