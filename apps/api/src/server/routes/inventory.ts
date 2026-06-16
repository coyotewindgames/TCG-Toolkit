import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest } from '../../common/http-errors';
import { schema } from '../../db/client';
import type { Container } from '../container';
import { requireAuth, requireRole } from '../auth/middleware';
import { InventoryImportService, type ImportResult } from '../services/inventory-import';
import { CatalogEnrichmentService } from '../services/catalog-enrichment';

const ImportBody = z.object({
  csv: z.string().min(1).max(50_000_000), // ~50 MB cap on the CSV string
  locationId: z.string().uuid().optional(),
  defaultCondition: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG']).optional(),
  defaultPrinting: z.enum(['Normal', 'Foil', 'Reverse', 'Holo', 'FirstEdition']).optional(),
  dryRun: z.boolean().optional(),
});

const ImportFileBody = z.object({
  locationId: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  locationID: z.string().uuid().optional(),
  defaultCondition: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG']).optional(),
  defaultPrinting: z.enum(['Normal', 'Foil', 'Reverse', 'Holo', 'FirstEdition']).optional(),
  dryRun: z.boolean().optional(),
});

const EnrichBody = z.object({
  onlyMissingImage: z.boolean().optional(),
});

/**
 * The wipe endpoint is destructive enough that we want a typed phrase as a
 * dead-man's switch — accidental fetch() calls or replayed requests should
 * not nuke a store's inventory.
 */
const WIPE_CONFIRM_PHRASE = 'DELETE ALL INVENTORY';
const WipeBody = z.object({
  confirm: z.literal(WIPE_CONFIRM_PHRASE),
});

function hasZipSignature(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

function hasNulByte(buf: Buffer): boolean {
  const sample = Math.min(buf.length, 2048);
  for (let i = 0; i < sample; i++) {
    if (buf[i] === 0x00) return true;
  }
  return false;
}

function parseImportUpload(file: Express.Multer.File): string {
  const originalName = (file.originalname ?? '').toLowerCase();
  const mime = (file.mimetype ?? '').toLowerCase();
  
  console.info('[csv-import] parseImportUpload called', {
    filename: file.originalname,
    size: file.size,
    mimetype: file.mimetype,
  });

  const isSpreadsheet =
    originalName.endsWith('.xlsx') ||
    originalName.endsWith('.xls') ||
    originalName.endsWith('.xlsm') ||
    mime.includes('spreadsheetml') ||
    mime === 'application/vnd.ms-excel' ||
    hasZipSignature(file.buffer);

  if (isSpreadsheet) {
    console.info('[csv-import] Spreadsheet upload detected', {
      filename: file.originalname,
      mimetype: file.mimetype,
      hasZipSignature: hasZipSignature(file.buffer),
    });

    try {
      const workbook = XLSX.read(file.buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      const firstSheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;

      if (!firstSheet) {
        throw BadRequest('Spreadsheet file does not contain any sheets.');
      }

      const csvText = XLSX.utils.sheet_to_csv(firstSheet, { blankrows: false });
      console.info('[csv-import] Spreadsheet converted to CSV', {
        filename: file.originalname,
        sheetName: firstSheetName,
        textLength: csvText.length,
      });
      return csvText;
    } catch (err) {
      if (err instanceof Error && err.message === 'Spreadsheet file does not contain any sheets.') {
        throw err;
      }

      console.error('[csv-import] Failed to parse spreadsheet upload', {
        filename: file.originalname,
        mimetype: file.mimetype,
        error: err instanceof Error ? err.message : String(err),
      });
      throw BadRequest('Unsupported spreadsheet file. Please upload a valid CSV, XLSX, or XLS file.');
    }
  }

  if (hasNulByte(file.buffer)) {
    console.error('[csv-import] REJECTED: Binary file with null bytes', {
      filename: file.originalname,
      mimetype: file.mimetype,
    });
    throw BadRequest('Unsupported file type. Only plain CSV text files are accepted.');
  }

  const csvText = file.buffer.toString('utf8');
  console.info('[csv-import] CSV text extracted', {
    filename: file.originalname,
    textLength: csvText.length,
    preview: csvText.slice(0, 200),
  });
  
  return csvText;
}

async function resolveImportLocationId(args: {
  db: Container['db'];
  storeId: string;
  requestedLocationId?: string;
}): Promise<string> {
  const { db, storeId, requestedLocationId } = args;

  if (requestedLocationId) {
    return requestedLocationId;
  }

  const locations = await db
    .select({ id: schema.locations.id })
    .from(schema.locations)
    .where(eq(schema.locations.storeId, storeId));

  if (locations.length === 1) {
    return locations[0].id;
  }

  if (locations.length === 0) {
    throw BadRequest('No locations exist for this store. Create a location first.');
  }

  throw BadRequest(
    'locationId is required when the store has multiple locations. Include form field locationId.',
  );
}

function shouldScheduleAutoEnrichment(result: ImportResult): boolean {
  if (result.dryRun) return false;
  const wroteInventory = result.inventoryCreated > 0 || result.inventoryUpdated > 0;
  const createdCatalog = result.productsCreated > 0 || result.skusCreated > 0;
  return wroteInventory || createdCatalog;
}

function scheduleAutoEnrichmentAfterImport(args: {
  enricher: CatalogEnrichmentService;
  storeId: string;
  result: ImportResult;
}): void {
  const { enricher, storeId, result } = args;
  if (!shouldScheduleAutoEnrichment(result)) {
    console.info('[enrichment] auto-backfill skipped after import', {
      storeId,
      dryRun: result.dryRun,
      productsCreated: result.productsCreated,
      skusCreated: result.skusCreated,
      inventoryCreated: result.inventoryCreated,
      inventoryUpdated: result.inventoryUpdated,
    });
    return;
  }

  console.info('[enrichment] auto-backfill scheduled after import', {
    storeId,
    productsCreated: result.productsCreated,
    skusCreated: result.skusCreated,
    inventoryCreated: result.inventoryCreated,
    inventoryUpdated: result.inventoryUpdated,
  });
  // Non-blocking: import response should not wait on enrichment lookups.
  enricher.runInBackground({ storeId, onlyMissingImage: true });
}

function scheduleAutoEnrichmentDeferred(args: {
  enricher: CatalogEnrichmentService;
  storeId: string;
  result: ImportResult;
}): void {
  setImmediate(() => {
    try {
      scheduleAutoEnrichmentAfterImport(args);
    } catch (err) {
      console.error('[enrichment] auto-backfill scheduling failed', {
        storeId: args.storeId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export function inventoryRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  const importer = new InventoryImportService(c.db);
  const enricher = new CatalogEnrichmentService(c.db, c.configs);

  r.post(
    '/import',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const body = ImportBody.parse(req.body ?? {});
      const locationId = await resolveImportLocationId({
        db: c.db,
        storeId: req.user!.storeId,
        requestedLocationId: body.locationId,
      });
      const result = await importer.import({
        storeId: req.user!.storeId,
        req: {
          ...body,
          locationId,
        },
      });
      res.json(result);
      scheduleAutoEnrichmentDeferred({
        enricher,
        storeId: req.user!.storeId,
        result,
      });
    }),
  );

  r.post(
    '/import/file',
    requireRole('owner', 'manager'),
    upload.single('file'),
    asyncHandler(async (req, res) => {
      console.info('[csv-import] /import/file request received', {
        storeId: req.user!.storeId,
        hasFile: !!req.file,
        fileName: req.file?.originalname,
        fileSize: req.file?.size,
        mimetype: req.file?.mimetype,
        bodyKeys: Object.keys(req.body ?? {}),
      });

      if (!req.file?.buffer) {
        console.error('[csv-import] No file in request');
        throw BadRequest(
          'CSV file is required. Send multipart/form-data with a file field named "file".',
        );
      }
      const body = ImportFileBody.parse({
        locationId: req.body?.locationId,
        location_id: req.body?.location_id,
        locationID: req.body?.locationID,
        defaultCondition: req.body?.defaultCondition || undefined,
        defaultPrinting: req.body?.defaultPrinting || undefined,
        dryRun:
          req.body?.dryRun === 'true'
            ? true
            : req.body?.dryRun === 'false'
              ? false
              : undefined,
      });

      console.info('[csv-import] Parsed request body', {
        locationId: body.locationId,
        location_id: body.location_id,
        locationID: body.locationID,
        defaultCondition: body.defaultCondition,
        defaultPrinting: body.defaultPrinting,
        dryRun: body.dryRun,
      });

      const resolvedLocationId = await resolveImportLocationId({
        db: c.db,
        storeId: req.user!.storeId,
        requestedLocationId: body.locationId ?? body.location_id ?? body.locationID,
      });

      console.info('[csv-import] Resolved location', {
        locationId: resolvedLocationId,
      });

      const csv = parseImportUpload(req.file);
      
      console.info('[csv-import] Calling import service', {
        storeId: req.user!.storeId,
        locationId: resolvedLocationId,
        csvLength: csv.length,
        dryRun: body.dryRun,
      });

      const result = await importer.import({
        storeId: req.user!.storeId,
        req: {
          csv,
          locationId: resolvedLocationId,
          defaultCondition: body.defaultCondition,
          defaultPrinting: body.defaultPrinting,
          dryRun: body.dryRun,
        },
      });

      console.info('[csv-import] Import completed', {
        storeId: req.user!.storeId,
        totalRows: result.totalRows,
        productsCreated: result.productsCreated,
        skusCreated: result.skusCreated,
        inventoryCreated: result.inventoryCreated,
        inventoryUpdated: result.inventoryUpdated,
        errors: result.errors.length,
        dryRun: result.dryRun,
      });
      res.json(result);
      scheduleAutoEnrichmentDeferred({
        enricher,
        storeId: req.user!.storeId,
        result,
      });
    }),
  );

  r.post(
    '/enrich',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const body = EnrichBody.parse(req.body ?? {});
      const result = await enricher.enrichStore({
        storeId: req.user!.storeId,
        onlyMissingImage: body.onlyMissingImage,
      });
      res.json(result);
    }),
  );

  r.get(
    '/summary',
    asyncHandler(async (req, res) => {
      const result = await c.inventory.summary(req.user!.storeId);
      res.json(result);
    }),
  );

  r.post(
    '/enrich/backfill',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const storeId = req.user!.storeId;
      console.info('[enrichment] backfill request start', { storeId });
      // Manual mode: one click == one batch.
      const result = await enricher.enrichStore({ storeId, onlyMissingImage: true });
      console.info('[enrichment] backfill request complete', {
        storeId,
        scanned: result.scanned,
        matched: result.matched,
        imagesUpdated: result.imagesUpdated,
        unmatched: result.unmatched.length,
        remaining: result.remaining,
      });
      res.json(result);
    }),
  );

  r.get(
    '/enrich/status',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const storeId = req.user!.storeId;
      const scope = { storeId, onlyMissingImage: true };
      const pending = await enricher.pendingCount(scope);
      // Polling endpoint: always return a fresh JSON payload, never 304.
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.set('Surrogate-Control', 'no-store');
      res.json({ pending, running: false });
    }),
  );

  /**
   * Destructive: wipe every quantity-on-hand row for this store's locations.
   * Leaves the catalog (products, skus, current_prices, price snapshots,
   * order/trade history) intact so it stays safe to run even on a store
   * that has sales — only the on-hand counts get zeroed. Owner-only.
   */
  r.post(
    '/wipe',
    requireRole('owner'),
    asyncHandler(async (req, res) => {
      const body = WipeBody.parse(req.body ?? {});
      // Belt-and-braces: zod literal already enforces this, but be loud.
      if (body.confirm !== WIPE_CONFIRM_PHRASE) throw BadRequest('confirmation phrase mismatch');

      const storeId = req.user!.storeId;
      const locs = await c.db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(eq(schema.locations.storeId, storeId));
      const locationIds = locs.map((l) => l.id);

      if (locationIds.length === 0) {
        res.json({ deleted: 0, locations: 0 });
        return;
      }

      const result = await c.db
        .delete(schema.inventory)
        .where(inArray(schema.inventory.locationId, locationIds))
        .returning({ skuId: schema.inventory.skuId });

      res.json({ deleted: result.length, locations: locationIds.length });
    }),
  );

  return r;
}
