import { Router } from 'express';
import { z } from 'zod';
import { CheckoutRequest, CreateOrderRequest } from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { requireAuth, requireRole } from '../auth/middleware';
import { validateBody } from '../middleware/validate';
import type { Container } from '../container';

const AddItemBody = z.object({ barcode: z.string().min(1) });

export function ordersRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.post(
    '/',
    validateBody(CreateOrderRequest),
    asyncHandler(async (req, res) => {
      const out = await c.orders.create({
        storeId: req.user!.storeId,
        locationId: req.body.locationId,
        registerId: req.body.registerId,
        customerId: req.body.customerId,
        userId: req.user!.id,
      });
      res.status(201).json(out);
    }),
  );

  r.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const out = await c.orders.findById(req.user!.storeId, req.params.id);
      res.json(out);
    }),
  );

  r.post(
    '/:id/items',
    validateBody(AddItemBody),
    asyncHandler(async (req, res) => {
      const out = await c.orders.addScannedItem({
        storeId: req.user!.storeId,
        orderId: req.params.id,
        barcode: req.body.barcode,
      });
      res.json(out);
    }),
  );

  r.post(
    '/:id/record-sale',
    requireRole('clerk', 'manager', 'owner'),
    asyncHandler(async (req, res) => {
      const out = await c.orders.recordSale({
        storeId: req.user!.storeId,
        orderId: req.params.id,
      });
      res.json(out);
    }),
  );

  r.delete(
    '/:id/items/:lineId',
    asyncHandler(async (req, res) => {
      const out = await c.orders.removeLine({
        storeId: req.user!.storeId,
        orderId: req.params.id,
        lineId: req.params.lineId,
      });
      res.json(out);
    }),
  );

  r.post(
    '/:id/checkout',
    requireRole('clerk', 'manager', 'owner'),
    validateBody(CheckoutRequest),
    asyncHandler(async (req, res) => {
      const out = await c.checkout.start(req.user!.storeId, req.params.id, req.body);
      res.json(out);
    }),
  );

  return r;
}
