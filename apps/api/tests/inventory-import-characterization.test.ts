/**
 * Characterization tests: they pin the import pipeline's observable behavior
 * (header synonyms, value coercion, per-row error reporting, dry runs) so the
 * decomposition of the service can be verified as behavior-preserving.
 */
import { describe, expect, it } from 'vitest';
import { InventoryImportService } from '../src/server/services/inventory-import';
import { FakeDatabase } from './helpers/fake-db';

function csv(...lines: string[]): string {
  return lines.join('\n');
}

async function runImport(csvText: string, overrides: Record<string, unknown> = {}) {
  const db = new FakeDatabase();
  const service = new InventoryImportService(db as never);
  const result = await service.import({
    storeId: 'store-1',
    req: { locationId: 'location-1', csv: csvText, ...overrides },
  });
  return { db, result };
}

describe('InventoryImportService (characterization)', () => {
  it('rejects a CSV without a name column', async () => {
    await expect(runImport(csv('Set,Quantity', 'Alpha,2'))).rejects.toThrow(
      /must include a Name column/,
    );
  });

  it('rejects a CSV with only a header row', async () => {
    await expect(runImport(csv('Name,Quantity'))).rejects.toThrow(
      /header row and at least one data row/,
    );
  });

  it('defaults condition, printing, language and quantity when columns are absent', async () => {
    const { db, result } = await runImport(csv('Name', 'Pikachu'));

    expect(result.totalRows).toBe(1);
    expect(result.errors).toEqual([]);
    expect(db.writes.skuValues[0]).toMatchObject({
      condition: 'NM',
      printing: 'Normal',
      language: 'EN',
    });
    expect(db.writes.inventoryValues[0]).toMatchObject({ qtyOnHand: 1 });
    expect(db.writes.currentPriceValues).toEqual([]);
  });

  it('honours caller-supplied defaults for condition and printing', async () => {
    const { db } = await runImport(csv('Name', 'Pikachu'), {
      defaultCondition: 'LP',
      defaultPrinting: 'Foil',
    });

    expect(db.writes.skuValues[0]).toMatchObject({ condition: 'LP', printing: 'Foil' });
  });

  it('records a row-level error for an unrecognized condition and keeps importing', async () => {
    const { result } = await runImport(
      csv('Name,Condition,Quantity', 'Pikachu,Sparkling,1', 'Charizard,Near Mint,1'),
    );

    expect(result.totalRows).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(2);
    expect(result.errors[0].message).toContain('unrecognized condition');
    expect(result.errors[0].data).toMatchObject({ Name: 'Pikachu' });
  });

  it('records a row-level error when the name cell is empty', async () => {
    const { result } = await runImport(csv('Name,Quantity', '" ",1'));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('missing name');
  });

  it('coerces currency-formatted prices to cents and derives a 50% buy price', async () => {
    const { db, result } = await runImport(
      csv('Name,Quantity,Cost,Market Price', 'Pikachu,3,"$1,234.56",$7.25'),
    );

    expect(result.costsApplied).toBe(1);
    expect(result.marketPricesApplied).toBe(1);
    expect(result.pricesSeeded).toBe(1);
    expect(db.writes.inventoryValues[0]).toMatchObject({ qtyOnHand: 3, costAvgCents: 123456 });
    expect(db.writes.currentPriceValues[0]).toMatchObject({
      sellPriceCents: 725,
      buyPriceCents: 363,
      marketPriceCents: 725,
    });
  });

  it('merges duplicate rows for the same SKU into one weighted-average inventory upsert', async () => {
    const { db, result } = await runImport(
      csv('Name,Quantity,Cost', 'Pikachu,1,1.00', 'Pikachu,3,5.00'),
    );

    expect(result.totalRows).toBe(2);
    expect(db.writes.inventoryValues).toHaveLength(1);
    // (100 * 1 + 500 * 3) / 4 = 400
    expect(db.writes.inventoryValues[0]).toMatchObject({ qtyOnHand: 4, costAvgCents: 400 });
  });

  it('maps game, printing and language synonyms onto canonical values', async () => {
    const { db } = await runImport(
      csv('Card Name,TCG,Variant,Lang', 'Pikachu,Pokemon,Reverse Holo,Japanese'),
    );

    expect(db.writes.productValues[0]).toMatchObject({ game: 'pokemon' });
    expect(db.writes.skuValues[0]).toMatchObject({ printing: 'Reverse', language: 'JP' });
  });

  it('reports counters for a dry run without leaving the caller a non-dry-run result', async () => {
    const { result } = await runImport(csv('Name,Quantity', 'Pikachu,2'), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.totalRows).toBe(1);
    expect(result.inventoryCreated).toBe(1);
  });
});
