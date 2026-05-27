import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';

export function healthRouter(): Router {
  const r = Router();
  r.get('/healthz', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });
  r.get('/readyz', async (_req, res) => {
    try {
      await getDb().execute(sql`select 1`);
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message });
    }
  });
  return r;
}
