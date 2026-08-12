import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Logger } from 'pino';
import { asyncHandler } from '../../common/async-handler';
import { requestLogger } from '../../common/logger';
import { BadRequest } from '../../common/http-errors';
import { parseImportUpload } from './import-upload';
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
 * Body for `POST /inventory/skus/:skuId/cost`. Accepts either the direct
 * integer cent value or a dollar amount (float or numeric string) that we
 * round to the nearest cent — the web form ships whichever is more natural.
 */
const SetCostBody = z
  .object({
    costCents: z.number().int().min(0).max(100_000_00).optional(),
    costDollars: z.union([z.number(), z.string()]).optional(),
  })
  .refine((v) => v.costCents != null || v.costDollars != null, {
    message: 'Provide costCents or costDollars.',
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
  log: Logger;
}): void {
  const { enricher, storeId, result, log } = args;
  if (!shouldScheduleAutoEnrichment(result)) {
    log.debug({ storeId, dryRun: result.dryRun }, 'auto-backfill skipped after import');
    return;
  }

  log.info({ storeId }, 'auto-backfill scheduled after import');
  // Non-blocking: import response should not wait on enrichment lookups.
  enricher.runInBackground({ storeId, onlyMissingImage: true });
}

function scheduleAutoEnrichmentDeferred(args: {
  enricher: CatalogEnrichmentService;
  storeId: string;
  result: ImportResult;
  log: Logger;
}): void {
  setImmediate(() => {
    try {
      scheduleAutoEnrichmentAfterImport(args);
    } catch (err) {
      args.log.error({ storeId: args.storeId, err }, 'auto-backfill scheduling failed');
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

  const enricher = new CatalogEnrichmentService(c.db, c.configs, c.pkmncardsClient);

  r.post(
    '/import',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const log = requestLogger(req);
      const body = ImportBody.parse(req.body ?? {});
      const locationId = await c.inventory.resolveImportLocationId({
        storeId: req.user!.storeId,
        requestedLocationId: body.locationId,
        log,
      });
      const result = await new InventoryImportService(c.db, log).import({
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
        log,
      });
    }),
  );

  r.post(
    '/import/file',
    requireRole('owner', 'manager'),
    upload.single('file'),
    asyncHandler(async (req, res) => {
      const log = requestLogger(req);
      if (!req.file?.buffer) {
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

      const resolvedLocationId = await c.inventory.resolveImportLocationId({
        storeId: req.user!.storeId,
        requestedLocationId: body.locationId ?? body.location_id ?? body.locationID,
        log,
      });

      const csv = parseImportUpload(req.file, log);

      const result = await new InventoryImportService(c.db, log).import({
        storeId: req.user!.storeId,
        req: {
          csv,
          locationId: resolvedLocationId,
          defaultCondition: body.defaultCondition,
          defaultPrinting: body.defaultPrinting,
          dryRun: body.dryRun,
        },
      });

      res.json(result);
      scheduleAutoEnrichmentDeferred({
        enricher,
        storeId: req.user!.storeId,
        result,
        log,
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

  /**
   * Overwrite the "picked up at" / cost basis for a SKU. The Inventory page
   * uses this when an operator needs to correct the auto-computed weighted
   * average — e.g. an off-flow cash purchase, or a mistyped trade-in value
   * that skewed the running average.
   *
   * Owner/manager-only because cost basis feeds directly into the store's
   * P&L reporting.
   */
  r.post(
    '/skus/:skuId/cost',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const skuId = req.params.skuId;
      if (!skuId || !/^[0-9a-f-]{36}$/i.test(skuId)) throw BadRequest('invalid sku id');
      const body = SetCostBody.parse(req.body ?? {});
      const costCents =
        body.costCents ?? Math.round(Number(body.costDollars) * 100);
      if (!Number.isFinite(costCents) || costCents < 0) {
        throw BadRequest('cost must be a non-negative number');
      }
      await c.inventory.setSkuCost({
        storeId: req.user!.storeId,
        skuId,
        costCents,
      });
      res.json({ ok: true, skuId, costCents });
    }),
  );

  r.post(
    '/enrich/backfill',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const storeId = req.user!.storeId;
      // Manual mode: one click == one batch.
      const result = await enricher.enrichStore({ storeId, onlyMissingImage: true });
      requestLogger(req).info(
        {
          storeId,
          scanned: result.scanned,
          matched: result.matched,
          imagesUpdated: result.imagesUpdated,
          unmatched: result.unmatched.length,
          remaining: result.remaining,
        },
        'enrichment backfill batch complete',
      );
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

      res.json(await c.inventory.wipeOnHandQuantities(req.user!.storeId));
    }),
  );

  return r;
}
