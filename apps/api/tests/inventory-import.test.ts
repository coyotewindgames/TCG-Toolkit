import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { InventoryImportService } from '../src/server/services/inventory-import';

type RecordedState = {
  inventoryValues: Array<Record<string, unknown>>;
  currentPriceValues: Array<Record<string, unknown>>;
};

class FakeDb {
  readonly state: RecordedState = {
    inventoryValues: [],
    currentPriceValues: [],
  };

  select() {
    return new FakeSelectBuilder();
  }

  insert(table: unknown) {
    return new FakeInsertBuilder(this.state, table);
  }

  update() {
    return new FakeUpdateBuilder();
  }

  async transaction<T>(cb: (tx: FakeDb) => Promise<T>): Promise<T> {
    return cb(this);
  }
}

class FakeSelectBuilder {
  private table: unknown;
  private whereCalled = false;
  private joinedTable: unknown;

  from(table: unknown) {
    this.table = table;
    return this;
  }

  innerJoin(table: unknown) {
    this.joinedTable = table;
    return this;
  }

  where() {
    this.whereCalled = true;
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.resolveRows()).then(onfulfilled, onrejected);
  }

  private resolveRows(): unknown[] {
    if (this.table === schema.currentPrices && this.joinedTable === schema.skus) {
      return [];
    }
    return [];
  }

  limit() {
    if (this.table === schema.locations) {
      return Promise.resolve([{ id: 'location-1', storeId: 'store-1' }]);
    }

    // Handle pre-flight validation queries for SKUs
    if (this.table === schema.skus && this.whereCalled) {
      return Promise.resolve([{ id: 'sku-1', storeId: 'store-1' }]);
    }

    return Promise.resolve([]);
  }
}

class FakeInsertBuilder {
  private valuesData: Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  private ignoreConflict = false;

  constructor(
    private readonly state: RecordedState,
    private readonly table: unknown,
  ) {}

  values(values: Record<string, unknown> | Array<Record<string, unknown>>) {
    this.valuesData = values;
    return this;
  }

  onConflictDoNothing() {
    this.ignoreConflict = true;
    return this;
  }

  onConflictDoUpdate() {
    if (this.table === schema.inventory && this.valuesData) {
      if (Array.isArray(this.valuesData)) {
        this.state.inventoryValues.push(...this.valuesData);
      } else {
        this.state.inventoryValues.push(this.valuesData);
      }
    }

    if (this.table === schema.currentPrices && this.valuesData) {
      if (Array.isArray(this.valuesData)) {
        this.state.currentPriceValues.push(...this.valuesData);
      } else {
        this.state.currentPriceValues.push(this.valuesData);
      }
    }

    return Promise.resolve([]);
  }

  returning() {
    if (this.table === schema.products) {
      const values = Array.isArray(this.valuesData)
        ? this.valuesData
        : this.valuesData
          ? [this.valuesData]
          : [];

      return Promise.resolve(
        values.map((value, index) => ({
          id: `product-${index + 1}`,
          game: value.game,
          name: value.name,
          setName: value.setName ?? null,
          cardNumber: value.cardNumber ?? null,
        })),
      );
    }

    if (this.table === schema.skus && this.ignoreConflict) {
      const values = Array.isArray(this.valuesData)
        ? this.valuesData
        : this.valuesData
          ? [this.valuesData]
          : [];

      return Promise.resolve(
        values.map((value, index) => ({
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
}

class FakeUpdateBuilder {
  set() {
    return this;
  }

  where() {
    return Promise.resolve();
  }
}

describe('InventoryImportService', () => {
  it('maps Average Cost Paid and dated Market Price headers into inventory and price writes', async () => {
    const db = new FakeDb();
    const service = new InventoryImportService(db as never);

    const result = await service.import({
      storeId: 'store-1',
      req: {
        locationId: 'location-1',
        csv: [
          'Product Name,Category,Set,Card Number,Variance,Card Condition,Average Cost Paid,Quantity,Market Price (As of 2026-06-12)',
          'Black Lotus,Magic: The Gathering,Alpha,233,Normal,Near Mint,2.50,2,7.25',
        ].join('\n'),
      },
    });

    expect(result.totalRows).toBe(1);
    expect(result.costsApplied).toBe(1);
    expect(result.marketPricesApplied).toBe(1);
    expect(result.errors).toEqual([]);

    expect(db.state.inventoryValues).toHaveLength(1);
    expect(db.state.inventoryValues[0]).toMatchObject({
      locationId: 'location-1',
      qtyOnHand: 2,
      costAvgCents: 250,
    });

    expect(db.state.currentPriceValues).toHaveLength(1);
    expect(db.state.currentPriceValues[0]).toMatchObject({
      sellPriceCents: 725,
      buyPriceCents: 363,
      marketPriceCents: 725,
    });
  });

  it('treats Variance=Unlimited as Normal printing', async () => {
    const db = new FakeDb();
    const service = new InventoryImportService(db as never);

    const result = await service.import({
      storeId: 'store-1',
      req: {
        locationId: 'location-1',
        csv: [
          'Product Name,Category,Set,Card Number,Variance,Card Condition,Average Cost Paid,Quantity,Market Price (As of 2026-06-12)',
          'Scyther,Pokemon,Neo Discovery,46,Unlimited,Near Mint,0.00,1,2.00',
        ].join('\n'),
      },
    });

    expect(result.totalRows).toBe(1);
    expect(result.errors).toEqual([]);
    expect(db.state.inventoryValues).toHaveLength(1);
    expect(db.state.currentPriceValues).toHaveLength(1);
  });
});