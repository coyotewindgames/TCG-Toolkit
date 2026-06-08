import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { schema } from '../../db/client';
import { BadRequest, NotFound } from '../../common/http-errors';
import type { Container } from '../container';
import { requireAuth } from '../auth/middleware';

const FormatSchema = z.enum(['code128', 'qr']).default('code128');

const LabelsRequest = z.object({
  format: z.enum(['code128', 'qr']).optional(),
  items: z
    .array(
      z.object({
        skuId: z.string().uuid(),
        copies: z.number().int().positive().max(50).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export function skusRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  // Per-SKU PNG: GET /skus/:id/barcode.png?format=code128|qr
  r.get(
    '/:id/barcode.png',
    asyncHandler(async (req, res) => {
      const format = FormatSchema.parse(req.query.format ?? 'code128');
      const [sku] = await c.db
        .select({ barcode: schema.skus.barcode })
        .from(schema.skus)
        .where(
          and(eq(schema.skus.id, req.params.id), eq(schema.skus.storeId, req.user!.storeId)),
        )
        .limit(1);
      if (!sku) throw NotFound(`sku ${req.params.id} not found`);

      const png =
        format === 'qr' ? await c.barcode.qr(sku.barcode) : await c.barcode.code128(sku.barcode);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(png);
    }),
  );

  // Batch label sheet: POST /skus/labels.pdf
  r.post(
    '/labels.pdf',
    asyncHandler(async (req, res) => {
      const body = LabelsRequest.parse(req.body ?? {});
      const ids = body.items.map((i) => i.skuId);

      const rows = await c.db
        .select({
          id: schema.skus.id,
          barcode: schema.skus.barcode,
          name: schema.products.name,
          sellPriceCents: schema.currentPrices.sellPriceCents,
        })
        .from(schema.skus)
        .innerJoin(schema.products, eq(schema.products.id, schema.skus.productId))
        .leftJoin(schema.currentPrices, eq(schema.currentPrices.skuId, schema.skus.id))
        .where(and(inArray(schema.skus.id, ids), eq(schema.skus.storeId, req.user!.storeId)));

      const byId = new Map(rows.map((r2) => [r2.id, r2]));
      const labels = body.items.map((it) => {
        const row = byId.get(it.skuId);
        if (!row) throw NotFound(`sku ${it.skuId} not found`);
        return {
          barcode: row.barcode,
          title: row.name,
          subtitle:
            row.sellPriceCents != null
              ? `$${(row.sellPriceCents / 100).toFixed(2)}`
              : undefined,
          copies: it.copies ?? 1,
        };
      });

      const total = labels.reduce((s, l) => s + (l.copies ?? 1), 0);
      if (total > 500) throw BadRequest('total label count exceeds 500');

      const pdf = await c.barcode.labelSheetPdf(labels, { format: body.format });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="sku-labels.pdf"');
      res.send(pdf);
    }),
  );

  return r;
}

// Token-keyed PNG endpoint: GET /barcodes/:token.png?format=...
export function barcodesRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/:token.png',
    asyncHandler(async (req, res) => {
      const format = FormatSchema.parse(req.query.format ?? 'code128');
      const [sku] = await c.db
        .select({ barcode: schema.skus.barcode })
        .from(schema.skus)
        .where(
          and(
            eq(schema.skus.barcode, req.params.token),
            eq(schema.skus.storeId, req.user!.storeId),
          ),
        )
        .limit(1);
      if (!sku) throw NotFound(`barcode ${req.params.token} not found`);

      const png =
        format === 'qr' ? await c.barcode.qr(sku.barcode) : await c.barcode.code128(sku.barcode);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(png);
    }),
  );

  return r;
}
