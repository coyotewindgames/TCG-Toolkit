import { Router } from 'express';
import { ScanRequest } from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { requireAuth } from '../auth/middleware';
import { validateBody } from '../middleware/validate';
import type { Container } from '../container';

export function scansRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.post(
    '/',
    validateBody(ScanRequest),
    asyncHandler(async (req, res) => {
      const result = await c.scans.resolveBarcode({
        storeId: req.user!.storeId,
        barcode: req.body.barcode,
      });
      res.json(result);
    }),
  );

  return r;
}
