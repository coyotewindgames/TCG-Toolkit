import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest } from '../../common/http-errors';
import type { Container } from '../container';
import { requireAuth } from '../auth/middleware';

const ImageBody = z.object({
  dataUrl: z.string().trim().min(1).max(1_050_000),
});

export function productsRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/search',
    asyncHandler(async (req, res) => {
      const q = (req.query.q as string | undefined) ?? '';
      const pageRaw = Number(req.query.page ?? 1);
      const pageSizeRaw = Number(req.query.pageSize ?? 25);
      const sortRaw = String(req.query.sort ?? 'name_asc');
      const sort =
        sortRaw === 'price_desc' || sortRaw === 'price_asc' || sortRaw === 'name_asc'
          ? sortRaw
          : 'name_asc';
      const setName = (req.query.set as string | undefined) ?? '';
      const rarity = (req.query.rarity as string | undefined) ?? '';
      const game = (req.query.game as string | undefined) ?? '';
      const language = (req.query.language as string | undefined) ?? '';
      const artist = (req.query.artist as string | undefined) ?? '';
      const includeParseDebugRaw = (req.query.includeParseDebug as string | undefined) ?? '';
      const includeParseDebug =
        includeParseDebugRaw === '1' || includeParseDebugRaw.toLowerCase() === 'true';

      const out = await c.products.search(req.user!.storeId, {
        query: q,
        page: Number.isFinite(pageRaw) ? pageRaw : 1,
        pageSize: Number.isFinite(pageSizeRaw) ? pageSizeRaw : 25,
        sort,
        setName,
        rarity,
        game,
        language,
        artist,
        includeParseDebug,
      });
      res.json(out);
    }),
  );

  r.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = await c.products.findById(req.user!.storeId, req.params.id);
      res.json(row);
    }),
  );

  r.get(
    '/:id/skus',
    asyncHandler(async (req, res) => {
      const rows = await c.products.listSkus(req.user!.storeId, req.params.id);
      res.json({ skus: rows });
    }),
  );

  r.put(
    '/:id/image',
    asyncHandler(async (req, res) => {
      const parsed = ImageBody.safeParse(req.body);
      if (!parsed.success) {
        throw BadRequest('Invalid image payload.', parsed.error.flatten());
      }
      const out = await c.products.setImageDataUrl(
        req.user!.storeId,
        req.params.id,
        parsed.data.dataUrl,
      );
      res.json(out);
    }),
  );

  r.delete(
    '/:id/image',
    asyncHandler(async (req, res) => {
      const out = await c.products.clearImage(req.user!.storeId, req.params.id);
      res.json(out);
    }),
  );

  return r;
}
