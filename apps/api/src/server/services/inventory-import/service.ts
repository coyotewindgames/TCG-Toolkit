/**
 * Orchestrates the CSV inventory import: read -> map -> validate -> batch ->
 * persist -> collect per-row errors. All SQL lives in
 * `InventoryImportRepository`; all row coercion lives in `row-validator`.
 */
import { randomUUID } from 'crypto';
import { skuIdentityKey } from '@tcg/shared';
import type { Logger } from 'pino';
import type { Database } from '../../../db/client';
import { BadRequest } from '../../../common/http-errors';
import { getLogger } from '../../../common/logger';
import { parseCsv } from './csv-row-reader';
import { indexHeaders } from './header-mapper';
import { describeImportError, toImportError } from './import-error';
import { validateImportRow, type ImportRowDefaults } from './row-validator';
import { InventoryImportRepository, type TransactionalDatabase } from './repository';
import {
  inventoryIdentityKey,
  productIdentityKey,
  type CurrentPricePayload,
  type ImportRecord,
  type ImportRequest,
  type ImportResult,
  type InventoryWithCostPayload,
  type InventoryWithoutCostPayload,
  type ParsedCsvRow,
  type ProductCandidate,
  type SkuCandidate,
} from './types';

const IMPORT_BATCH_SIZE = 1000;

/** CSV rows are 1-indexed and the header occupies row 1. */
function csvRowNumber(rowIndex: number): number {
  return rowIndex + 2;
}

/** Mutable state shared by every batch of a single import run. */
interface ImportRun {
  storeId: string;
  locationId: string;
  defaults: ImportRowDefaults;
  rows: ParsedCsvRow[];
  result: ImportResult;
  productIdByKey: Map<string, string>;
  skuIdByKey: Map<string, string>;
  existingInventoryKeys: Set<string>;
  pricedSkuIds: Set<string>;
}

interface BatchMetrics {
  validRows: number;
  productsToInsert: number;
  skusToInsert: number;
  inventoryWithCostRows: number;
  inventoryWithoutCostRows: number;
  priceRows: number;
}

const EMPTY_BATCH_METRICS: BatchMetrics = {
  validRows: 0,
  productsToInsert: 0,
  skusToInsert: 0,
  inventoryWithCostRows: 0,
  inventoryWithoutCostRows: 0,
  priceRows: 0,
};

export class InventoryImportService {
  private readonly repository: InventoryImportRepository;
  private resolvedLogger: Logger | null = null;

  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {
    this.repository = new InventoryImportRepository(db);
  }

  /** Resolved lazily so constructing the service never requires env config. */
  private get log(): Logger {
    if (!this.resolvedLogger) {
      this.resolvedLogger = (this.logger ?? getLogger()).child({ service: 'inventory-import' });
    }
    return this.resolvedLogger;
  }

  async import(args: { storeId: string; req: ImportRequest }): Promise<ImportResult> {
    const { storeId, req } = args;
    const startedAtMs = Date.now();

    const location = await this.repository.findLocationInStore(storeId, req.locationId);
    if (!location) {
      throw BadRequest('locationId not found in this store');
    }

    const rows = await parseCsv(req.csv);
    if (rows.length < 1) {
      throw BadRequest('CSV must have a header row and at least one data row');
    }

    const headers = Object.keys(rows[0] ?? {});
    if (indexHeaders(headers).name === undefined) {
      throw BadRequest('CSV must include a Name column (accepted: Name, Card Name, Product Name, Title)');
    }

    const run = await this.startImportRun(storeId, req, rows);

    if (req.dryRun) {
      await this.persistDryRun(run);
    } else {
      await this.persistAllBatches(run);
    }

    this.log.info(
      {
        storeId,
        locationId: req.locationId,
        dryRun: !!req.dryRun,
        rows: run.result.totalRows,
        productsCreated: run.result.productsCreated,
        skusCreated: run.result.skusCreated,
        inventoryCreated: run.result.inventoryCreated,
        inventoryUpdated: run.result.inventoryUpdated,
        errors: run.result.errors.length,
        elapsedMs: Date.now() - startedAtMs,
      },
      'inventory import finished',
    );

    return run.result;
  }

  /** Pre-warms the identity caches so the per-row loop avoids single-row SELECTs. */
  private async startImportRun(storeId: string, req: ImportRequest, rows: ParsedCsvRow[]): Promise<ImportRun> {
    const warm = await this.repository.loadExistingIdentities(storeId, req.locationId);

    const run: ImportRun = {
      storeId,
      locationId: req.locationId,
      defaults: {
        storeId,
        defaultCondition: req.defaultCondition ?? 'NM',
        defaultPrinting: req.defaultPrinting ?? 'Normal',
      },
      rows,
      result: {
        totalRows: 0,
        productsCreated: 0,
        skusCreated: 0,
        inventoryCreated: 0,
        inventoryUpdated: 0,
        costsApplied: 0,
        pricesSeeded: 0,
        marketPricesApplied: 0,
        errors: [],
        dryRun: !!req.dryRun,
      },
      productIdByKey: new Map(),
      skuIdByKey: new Map(),
      existingInventoryKeys: new Set(),
      pricedSkuIds: new Set(),
    };

    for (const product of warm.products) {
      run.productIdByKey.set(
        productIdentityKey({
          storeId,
          game: product.game,
          name: product.name,
          setName: product.setName,
          cardNumber: product.cardNumber,
        }),
        product.id,
      );
    }
    for (const sku of warm.skus) {
      run.skuIdByKey.set(
        skuIdentityKey({
          productId: sku.productId,
          condition: sku.condition,
          printing: sku.printing,
          language: sku.language,
        }),
        sku.id,
      );
    }
    for (const skuId of warm.inventorySkuIds) {
      run.existingInventoryKeys.add(inventoryIdentityKey({ skuId, locationId: req.locationId }));
    }
    for (const skuId of warm.pricedSkuIds) {
      run.pricedSkuIds.add(skuId);
    }

    return run;
  }

  /**
   * Runs the whole file inside a transaction that is always rolled back, so a
   * dry run exercises the real write path (and its counters) without persisting.
   */
  private async persistDryRun(run: ImportRun): Promise<void> {
    await this.db
      .transaction(async (tx) => {
        await this.persistValidatedRowBatch(tx as TransactionalDatabase, run, 0, run.rows.length);
        throw new RollbackForDryRun();
      })
      .catch((err) => {
        if (err instanceof RollbackForDryRun) return;
        throw err;
      });
  }

  private async persistAllBatches(run: ImportRun): Promise<void> {
    for (let batchStart = 0; batchStart < run.rows.length; batchStart += IMPORT_BATCH_SIZE) {
      const batchEndExclusive = Math.min(run.rows.length, batchStart + IMPORT_BATCH_SIZE);
      const batchStartedAtMs = Date.now();

      const metrics = await this.db.transaction(async (tx) =>
        this.persistValidatedRowBatch(tx as TransactionalDatabase, run, batchStart, batchEndExclusive),
      );

      this.log.info(
        {
          storeId: run.storeId,
          locationId: run.locationId,
          startRow: csvRowNumber(batchStart),
          endRow: batchEndExclusive + 1,
          rowsProcessed: batchEndExclusive - batchStart,
          ...metrics,
          elapsedMs: Date.now() - batchStartedAtMs,
        },
        'inventory import batch committed',
      );
    }
  }

  /** Validates and persists rows `[batchStart, batchEndExclusive)` in one transaction. */
  private async persistValidatedRowBatch(
    tx: TransactionalDatabase,
    run: ImportRun,
    batchStart: number,
    batchEndExclusive: number,
  ): Promise<BatchMetrics> {
    const repository = InventoryImportRepository.forTransaction(tx);
    const { records, productCandidates } = this.validateRowRange(run, batchStart, batchEndExclusive);

    if (!records.length) {
      return EMPTY_BATCH_METRICS;
    }

    await this.ensureProductsExist(repository, run, productCandidates);

    const recordsWithProduct: Array<ImportRecord & { productId: string; skuKey: string }> = [];
    const skuCandidatesByKey = new Map<string, SkuCandidate>();

    for (const record of records) {
      const productId = run.productIdByKey.get(record.productKey);
      if (!productId) {
        this.recordRowFailure(run, record.rowIndex, record.rawRow, new Error('could not resolve product identity after bulk insert'));
        continue;
      }

      const skuKey = skuIdentityKey({
        productId,
        condition: record.condition,
        printing: record.printing,
        language: record.language,
      });

      recordsWithProduct.push({ ...record, productId, skuKey });

      if (!run.skuIdByKey.has(skuKey) && !skuCandidatesByKey.has(skuKey)) {
        skuCandidatesByKey.set(skuKey, {
          skuKey,
          id: randomUUID(),
          productId,
          condition: record.condition,
          printing: record.printing,
          language: record.language,
        });
      }
    }

    await this.ensureSkusExist(repository, run, [...skuCandidatesByKey.values()]);

    const writes = this.buildInventoryWrites(run, recordsWithProduct);

    // Rows with and without a cost basis use different upsert semantics, so
    // they are written separately.
    await repository.upsertInventoryWithCost(writes.inventoryWithCost);
    await repository.upsertInventoryWithoutCost(writes.inventoryWithoutCost);
    await repository.upsertCurrentPrices(writes.currentPrices);

    return {
      validRows: records.length,
      productsToInsert: productCandidates.length,
      skusToInsert: skuCandidatesByKey.size,
      inventoryWithCostRows: writes.inventoryWithCost.length,
      inventoryWithoutCostRows: writes.inventoryWithoutCost.length,
      priceRows: writes.currentPrices.length,
    };
  }

  /** CPU-only pass: coerce each raw row and collect the products to create. */
  private validateRowRange(
    run: ImportRun,
    batchStart: number,
    batchEndExclusive: number,
  ): { records: ImportRecord[]; productCandidates: ProductCandidate[] } {
    const records: ImportRecord[] = [];
    const productCandidatesByKey = new Map<string, ProductCandidate>();

    for (let rowIndex = batchStart; rowIndex < batchEndExclusive; rowIndex++) {
      const rawRow = run.rows[rowIndex] as ParsedCsvRow;
      run.result.totalRows++;
      try {
        const record = validateImportRow(rowIndex, rawRow, run.defaults);
        records.push(record);

        if (!run.productIdByKey.has(record.productKey) && !productCandidatesByKey.has(record.productKey)) {
          productCandidatesByKey.set(record.productKey, {
            productKey: record.productKey,
            game: record.game,
            name: record.name,
            setName: record.setName,
            setCode: record.setCode,
            cardNumber: record.cardNumber,
            rarity: record.rarity,
          });
        }
      } catch (err) {
        this.recordRowFailure(run, rowIndex, rawRow, err);
      }
    }

    return { records, productCandidates: [...productCandidatesByKey.values()] };
  }

  /**
   * Inserts the missing products, then re-reads any candidate the insert
   * skipped because it already existed, so every candidate ends up cached.
   */
  private async ensureProductsExist(
    repository: InventoryImportRepository,
    run: ImportRun,
    candidates: ProductCandidate[],
  ): Promise<void> {
    if (!candidates.length) return;

    const inserted = await repository.insertProducts(run.storeId, candidates);
    for (const product of inserted) {
      const productKey = productIdentityKey({
        storeId: run.storeId,
        game: product.game,
        name: product.name,
        setName: product.setName,
        cardNumber: product.cardNumber,
      });
      if (!run.productIdByKey.has(productKey)) {
        run.productIdByKey.set(productKey, product.id);
        run.result.productsCreated++;
      }
    }

    const unresolved = candidates.filter((candidate) => !run.productIdByKey.has(candidate.productKey));
    if (!unresolved.length) return;

    const existing = await repository.findProductsByIdentity(run.storeId, unresolved);
    for (const product of existing) {
      const productKey = productIdentityKey({
        storeId: run.storeId,
        game: product.game,
        name: product.name,
        setName: product.setName,
        cardNumber: product.cardNumber,
      });
      if (!run.productIdByKey.has(productKey)) {
        run.productIdByKey.set(productKey, product.id);
      }
    }

    if (unresolved.some((candidate) => !run.productIdByKey.has(candidate.productKey))) {
      throw new Error('could not resolve product identity after bulk insert');
    }
  }

  /** Same insert-then-reconcile flow as `ensureProductsExist`, for SKUs. */
  private async ensureSkusExist(
    repository: InventoryImportRepository,
    run: ImportRun,
    candidates: SkuCandidate[],
  ): Promise<void> {
    if (!candidates.length) return;

    const inserted = await repository.insertSkus(run.storeId, candidates);
    for (const sku of inserted) {
      const skuKey = skuIdentityKey({
        productId: sku.productId,
        condition: sku.condition,
        printing: sku.printing,
        language: sku.language,
      });
      if (!run.skuIdByKey.has(skuKey)) {
        run.skuIdByKey.set(skuKey, sku.id);
        run.result.skusCreated++;
      }
    }

    const unresolved = candidates.filter((candidate) => !run.skuIdByKey.has(candidate.skuKey));
    if (!unresolved.length) return;

    const existing = await repository.findSkusByIdentity(unresolved);
    for (const sku of existing) {
      const skuKey = skuIdentityKey({
        productId: sku.productId,
        condition: sku.condition,
        printing: sku.printing,
        language: sku.language,
      });
      if (!run.skuIdByKey.has(skuKey)) {
        run.skuIdByKey.set(skuKey, sku.id);
      }
    }

    if (unresolved.some((candidate) => !run.skuIdByKey.has(candidate.skuKey))) {
      throw new Error('could not resolve SKU identity after bulk insert');
    }
  }

  /**
   * Resolves SKU ids, merges rows that target the same SKU/location, and
   * updates the run counters.
   */
  private buildInventoryWrites(
    run: ImportRun,
    records: Array<ImportRecord & { productId: string; skuKey: string }>,
  ): {
    inventoryWithCost: InventoryWithCostPayload[];
    inventoryWithoutCost: InventoryWithoutCostPayload[];
    currentPrices: CurrentPricePayload[];
  } {
    const withCostByKey = new Map<string, { skuId: string; locationId: string; qty: number; costNumerator: number }>();
    const withoutCostByKey = new Map<string, InventoryWithoutCostPayload>();
    const currentPricesBySkuId = new Map<string, CurrentPricePayload>();

    for (const record of records) {
      const skuId = run.skuIdByKey.get(record.skuKey);
      if (!skuId) {
        this.recordRowFailure(run, record.rowIndex, record.rawRow, new Error('could not resolve SKU identity after bulk insert'));
        continue;
      }

      const inventoryKey = inventoryIdentityKey({ skuId, locationId: run.locationId });
      if (run.existingInventoryKeys.has(inventoryKey)) {
        run.result.inventoryUpdated++;
      } else {
        run.result.inventoryCreated++;
        run.existingInventoryKeys.add(inventoryKey);
      }

      if (record.costCents != null) {
        run.result.costsApplied++;
        const existing = withCostByKey.get(inventoryKey);
        if (existing) {
          existing.qty += record.qty;
          existing.costNumerator += record.costCents * record.qty;
        } else {
          withCostByKey.set(inventoryKey, {
            skuId,
            locationId: run.locationId,
            qty: record.qty,
            costNumerator: record.costCents * record.qty,
          });
        }
      } else {
        const existing = withoutCostByKey.get(inventoryKey);
        if (existing) {
          existing.qty += record.qty;
        } else {
          withoutCostByKey.set(inventoryKey, { skuId, locationId: run.locationId, qty: record.qty });
        }
      }

      if (record.marketCents != null) {
        if (!run.pricedSkuIds.has(skuId)) {
          run.result.pricesSeeded++;
          run.pricedSkuIds.add(skuId);
        }
        run.result.marketPricesApplied++;
        currentPricesBySkuId.set(skuId, { skuId, marketCents: record.marketCents });
      }
    }

    return {
      inventoryWithCost: [...withCostByKey.values()].map((row) => ({
        skuId: row.skuId,
        locationId: row.locationId,
        qty: row.qty,
        weightedCostCents: Math.round(row.costNumerator / row.qty),
      })),
      inventoryWithoutCost: [...withoutCostByKey.values()],
      currentPrices: [...currentPricesBySkuId.values()],
    };
  }

  /** Logs a failed row once and adds it to the user-facing error list. */
  private recordRowFailure(run: ImportRun, rowIndex: number, rawRow: ParsedCsvRow, err: unknown): void {
    const error = toImportError(err);
    const row = csvRowNumber(rowIndex);

    this.log.error(
      {
        row,
        storeId: run.storeId,
        locationId: run.locationId,
        code: error.code,
        detail: error.detail,
        hint: error.hint,
        constraint: error.constraint,
        table: error.table,
        column: error.column,
        err,
      },
      'inventory import row failed',
    );

    run.result.errors.push({ row, message: describeImportError(error), data: rawRow });
  }
}

/** Sentinel used to abort (and therefore roll back) the dry-run transaction. */
class RollbackForDryRun extends Error {
  constructor() {
    super('dry-run rollback');
  }
}
