import { Router } from 'express';
import {
  CreateTradeRequest,
  PAYOUT_KINDS,
  TRADE_STATUSES,
  type PayoutKind,
  type TradeStatus,
} from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { requireAuth, requireRole } from '../auth/middleware';
import { validateBody } from '../middleware/validate';
import type { Container } from '../container';

export function tradeinsRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const pageRaw = Number(req.query.page ?? 1);
      const pageSizeRaw = Number(req.query.pageSize ?? 25);
      const statusRaw = req.query.status as string | undefined;
      const status = (TRADE_STATUSES as readonly string[]).includes(statusRaw ?? '')
        ? (statusRaw as TradeStatus)
        : undefined;
      const payoutRaw = req.query.payout as string | undefined;
      const payout = (PAYOUT_KINDS as readonly string[]).includes(payoutRaw ?? '')
        ? (payoutRaw as PayoutKind)
        : undefined;
      const dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined;
      const dateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined;

      const out = await c.tradeins.list({
        storeId: req.user!.storeId,
        page: Number.isFinite(pageRaw) ? pageRaw : 1,
        pageSize: Number.isFinite(pageSizeRaw) ? pageSizeRaw : 25,
        status,
        payout,
        dateFrom,
        dateTo,
      });
      res.json(out);
    }),
  );

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
    '/:id/bill-of-sale.pdf',
    asyncHandler(async (req, res) => {
      const pdf = await c.billOfSale.tradeInPdf({
        storeId: req.user!.storeId,
        tradeId: req.params.id,
      });
      res.type('application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="bill-of-sale-${req.params.id.slice(0, 8)}.pdf"`,
      );
      res.send(pdf);
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
