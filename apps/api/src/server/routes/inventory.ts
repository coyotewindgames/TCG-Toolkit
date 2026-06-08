import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest } from '../../common/http-errors';
import { schema } from '../../db/client';
import type { Container } from '../container';
import { requireAuth, requireRole } from '../auth/middleware';
import { InventoryImportService } from '../services/inventory-import';
import { CatalogEnrichmentService } from '../services/catalog-enrichment';

const ImportBody = z.object({
  csv: z.string().min(1).max(50_000_000), // ~50 MB cap on the CSV string
  locationId: z.string().uuid(),
  defaultCondition: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG']).optional(),
  defaultPrinting: z.enum(['Normal', 'Foil', 'Reverse', 'Holo', 'FirstEdition']).optional(),
  dryRun: z.boolean().optional(),
});

const ImportFileBody = z.object({
  locationId: z.string().uuid(),
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
      const result = await importer.import({ storeId: req.user!.storeId, req: body });

      // After a real import, do one small enrichment batch synchronously so
      // the most recent products get images right away. We deliberately do
      // NOT loop here — tcgapi.dev's free tier is capped at 100 req/day, so
      // the rest of the catalog has to be backfilled deliberately from
      // Settings → "Backfill now".
      let enrichmentRan = false;
      if (!result.dryRun && result.productsCreated > 0) {
        try {
          const status = await c.configs.getTcgapiStatus(req.user!.storeId);
          if (status.configured && status.hasKey) {
            await enricher.enrichStore({
              storeId: req.user!.storeId,
              onlyMissingImage: true,
            });
            enrichmentRan = true;
          }
        } catch {
          // ignore — enrichment is best-effort
        }
      }
      res.json({ ...result, enrichmentRan });
    }),
  );

  r.post(
    '/import/file',
    requireRole('owner', 'manager'),
    upload.single('file'),
    asyncHandler(async (req, res) => {
      if (!req.file?.buffer) throw BadRequest('CSV file is required');
      const body = ImportFileBody.parse({
        locationId: req.body?.locationId,
        defaultCondition: req.body?.defaultCondition || undefined,
        defaultPrinting: req.body?.defaultPrinting || undefined,
        dryRun:
          req.body?.dryRun === 'true'
            ? true
            : req.body?.dryRun === 'false'
              ? false
              : undefined,
      });

      const csv = req.file.buffer.toString('utf8');
      const result = await importer.import({
        storeId: req.user!.storeId,
        req: {
          csv,
          locationId: body.locationId,
          defaultCondition: body.defaultCondition,
          defaultPrinting: body.defaultPrinting,
          dryRun: body.dryRun,
        },
      });

      let enrichmentRan = false;
      if (!result.dryRun && result.productsCreated > 0) {
        try {
          const status = await c.configs.getTcgapiStatus(req.user!.storeId);
          if (status.configured && status.hasKey) {
            await enricher.enrichStore({
              storeId: req.user!.storeId,
              onlyMissingImage: true,
            });
            enrichmentRan = true;
          }
        } catch {
          // ignore — enrichment is best-effort
        }
      }

      res.json({ ...result, enrichmentRan });
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

  r.post(
    '/enrich/backfill',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const storeId = req.user!.storeId;
      const status = await c.configs.getTcgapiStatus(storeId);
      if (!status.configured || !status.hasKey) {
        res.status(400).json({ error: 'TCGapi.dev is not configured for this store.' });
        return;
      }
      // One batch only. The free-tier daily cap means we cannot safely loop.
      const result = await enricher.enrichStore({ storeId, onlyMissingImage: true });
      res.json(result);
    }),
  );

  r.get(
    '/enrich/status',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const storeId = req.user!.storeId;
      const pending = await enricher.pendingCount({ storeId, onlyMissingImage: true });
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
