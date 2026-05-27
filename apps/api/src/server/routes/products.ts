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
      const results = await c.products.search(req.user!.storeId, q);
      res.json({ results });
    }),
  );

  r.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = await c.products.findById(req.user!.storeId, req.params.id);
      res.json(row);
    }),
  );

  return r;
}
