import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import type { Container } from '../container';
import { requireAuth } from '../auth/middleware';
import { AnalyticsService, type AnalyticsRange } from '../services/analytics';

const QueryRange = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function parseRange(query: unknown): AnalyticsRange {
  const parsed = QueryRange.safeParse(query);
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (!parsed.success) return { from: defaultFrom, to: now };
  const from = parsed.data.from ? new Date(parsed.data.from) : defaultFrom;
  const to = parsed.data.to ? new Date(parsed.data.to) : now;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
    return { from: defaultFrom, to: now };
  }
  return { from, to };
}

export function analyticsRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  const analytics = new AnalyticsService(c.db);

  r.get(
    '/summary',
    asyncHandler(async (req, res) => {
      const range = parseRange(req.query);
      const out = await analytics.summary(req.user!.storeId, range);
      res.json(out);
    }),
  );

  r.get(
    '/sales-series',
    asyncHandler(async (req, res) => {
      const range = parseRange(req.query);
      const out = await analytics.salesSeries(req.user!.storeId, range);
      res.json({ points: out });
    }),
  );

  r.get(
    '/tradein-series',
    asyncHandler(async (req, res) => {
      const range = parseRange(req.query);
      const out = await analytics.tradeinSeries(req.user!.storeId, range);
      res.json({ points: out });
    }),
  );

  r.get(
    '/cards-by-game',
    asyncHandler(async (req, res) => {
      const out = await analytics.cardsByGame(req.user!.storeId);
      res.json({ points: out });
    }),
  );

  r.get(
    '/price-kpis',
    asyncHandler(async (req, res) => {
      const out = await analytics.priceKpis(req.user!.storeId);
      res.json(out);
    }),
  );

  return r;
}
