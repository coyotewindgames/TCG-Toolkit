import { Router } from 'express';
import { CreateTradeRequest } from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { requireAuth, requireRole } from '../auth/middleware';
import { validateBody } from '../middleware/validate';
import type { Container } from '../container';

export function tradeinsRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.post(
    '/',
    validateBody(CreateTradeRequest),
    asyncHandler(async (req, res) => {
      const out = await c.tradeins.create({
        storeId: req.user!.storeId,
        userId: req.user!.id,
        body: req.body,
      });
      res.status(201).json(out);
    }),
  );

  r.post(
    '/:id/approve',
    requireRole('manager', 'owner'),
    asyncHandler(async (req, res) => {
      const out = await c.tradeins.approve({
        storeId: req.user!.storeId,
        tradeId: req.params.id,
        userId: req.user!.id,
      });
      res.json(out);
    }),
  );

  r.get(
    '/barcode/:token.png',
    asyncHandler(async (req, res) => {
      const png = await c.barcode.code128(req.params.token);
      res.type('image/png').send(png);
    }),
  );

  r.get(
    '/qr/:token.png',
    asyncHandler(async (req, res) => {
      const png = await c.barcode.qr(req.params.token);
      res.type('image/png').send(png);
    }),
  );

  return r;
}
