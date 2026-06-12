import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler';
import type { Container } from '../container';
import { requireAuth } from '../auth/middleware';

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

      const out = await c.products.search(req.user!.storeId, {
        query: q,
        page: Number.isFinite(pageRaw) ? pageRaw : 1,
        pageSize: Number.isFinite(pageSizeRaw) ? pageSizeRaw : 25,
        sort,
        setName,
        rarity,
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

  return r;
}
