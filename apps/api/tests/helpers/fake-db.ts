/**
 * Minimal in-memory stand-in for the Drizzle `Database` handle, sufficient for
 * exercising the inventory import pipeline without a live Postgres. It records
 * the values handed to `insert(...).values(...)` so tests can assert on writes.
 */
import { schema } from '../../src/db/client';

export interface RecordedWrites {
  productValues: Array<Record<string, unknown>>;
  skuValues: Array<Record<string, unknown>>;
  inventoryValues: Array<Record<string, unknown>>;
  currentPriceValues: Array<Record<string, unknown>>;
}

export class FakeDatabase {
  readonly writes: RecordedWrites = {
    productValues: [],
    skuValues: [],
    inventoryValues: [],
    currentPriceValues: [],
  };

  select() {
    return new FakeSelectBuilder();
  }

  insert(table: unknown) {
    return new FakeInsertBuilder(this.writes, table);
  }

  async transaction<T>(callback: (tx: FakeDatabase) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

class FakeSelectBuilder {
  private table: unknown;

  from(table: unknown) {
    this.table = table;
    return this;
  }

  innerJoin() {
    return this;
  }

  where() {
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve([] as unknown[]).then(onfulfilled, onrejected);
  }

  limit() {
    if (this.table === schema.locations) {
      return Promise.resolve([{ id: 'location-1', storeId: 'store-1' }]);
    }
    return Promise.resolve([]);
  }
}

class FakeInsertBuilder {
  private pendingValues: Array<Record<string, unknown>> = [];

  constructor(
    private readonly writes: RecordedWrites,
    private readonly table: unknown,
  ) {}

  values(values: Record<string, unknown> | Array<Record<string, unknown>>) {
    this.pendingValues = Array.isArray(values) ? values : [values];
    return this;
  }

  onConflictDoNothing() {
    return this;
  }

  onConflictDoUpdate() {
    this.record();
    return Promise.resolve([]);
  }

  returning() {
    this.record();
    if (this.table === schema.products) {
      return Promise.resolve(
        this.pendingValues.map((value, index) => ({
          id: `product-${index + 1}`,
          game: value.game,
          name: value.name,
          setName: value.setName ?? null,
          cardNumber: value.cardNumber ?? null,
        })),
      );
    }
    if (this.table === schema.skus) {
      return Promise.resolve(
        this.pendingValues.map((value, index) => ({
          id: (value.id as string) ?? `sku-${index + 1}`,
          productId: value.productId,
          condition: value.condition,
          printing: value.printing,
          language: value.language,
        })),
      );
    }
    return Promise.resolve([]);
  }

  private record() {
    if (this.table === schema.products) this.writes.productValues.push(...this.pendingValues);
    if (this.table === schema.skus) this.writes.skuValues.push(...this.pendingValues);
    if (this.table === schema.inventory) this.writes.inventoryValues.push(...this.pendingValues);
    if (this.table === schema.currentPrices) {
      this.writes.currentPriceValues.push(...this.pendingValues);
    }
  }
}
