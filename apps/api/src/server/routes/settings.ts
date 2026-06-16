import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest, Forbidden, NotFound } from '../../common/http-errors';
import { schema } from '../../db/client';
import { CloverClient } from '../../integrations/pos/clover';
import { TcgapiClient } from '../../integrations/tcgapi/client';
import { requireAuth, requireRole } from '../auth/middleware';
import { verifyPassword } from '../auth/service';
import type { Container } from '../container';
import {
  getOnboardingStatus,
  completeOnboarding,
} from '../services/onboarding-service';

/**
 * Step-up validation: every credential mutation re-prompts the caller for
 * their password. Cheap defense against a stolen access cookie being used to
 * silently swap an integration secret out from under the owner.
 */
const StepUp = z.object({ password: z.string().min(1) });

const TcgapiUpsert = StepUp.extend({
  baseUrl: z.string().url().default('https://api.tcgapi.dev/v1'),
  apiKey: z.string().min(8).optional(),
});

// Onboarding variant — same fields but no password step-up required.
const TcgapiOnboardingUpsert = z.object({
  baseUrl: z.string().url().default('https://api.tcgapi.dev/v1'),
  apiKey: z.string().min(8).optional(),
});

const PosUpsert = StepUp.extend({
  baseUrl: z.string().url(),
  merchantId: z.string().min(1),
  accessToken: z.string().min(8).optional(),
  webhookSigningSecret: z.string().min(8).optional(),
});

export function settingsRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);
  // Only owners may view or change integration credentials. Managers/clerks
  // still hit the rest of the API normally.
  r.use(requireRole('owner'));

  // ---- Store info ---------------------------------------------------------

  r.get(
    '/store',
    asyncHandler(async (req, res) => {
      const [row] = await c.db
        .select({ name: schema.stores.name, timezone: schema.stores.timezone })
        .from(schema.stores)
        .where(eq(schema.stores.id, req.user!.storeId))
        .limit(1);
      if (!row) throw NotFound('store not found');
      res.json(row);
    }),
  );

  // ---- Onboarding status --------------------------------------------------

  r.get(
    '/onboarding-status',
    asyncHandler(async (req, res) => {
      const status = await getOnboardingStatus(c.db, req.user!.storeId);
      res.json(status);
    }),
  );

  r.post(
    '/onboarding-complete',
    asyncHandler(async (req, res) => {
      await completeOnboarding(c.db, req.user!.storeId);
      res.json({ ok: true });
    }),
  );

  // ---- Read ---------------------------------------------------------------

  r.get(
    '/integrations',
    asyncHandler(async (req, res) => {
      const [tcgapi, pos] = await Promise.all([
        c.configs.getTcgapiStatus(req.user!.storeId),
        c.configs.getPosStatus(req.user!.storeId),
      ]);
      res.json({ tcgapi, pos });
    }),
  );

  // ---- TCGapi.dev ---------------------------------------------------------

  r.put(
    '/integrations/tcgapi',
    asyncHandler(async (req, res) => {
      const body = TcgapiUpsert.parse(req.body ?? {});
      await assertStepUp(c, req.user!.id, body.password);

      const existing = await c.configs.getTcgapiStatus(req.user!.storeId);
      if (!existing.configured && !body.apiKey) {
        throw BadRequest('apiKey is required when configuring TCGapi.dev for the first time');
      }

      await c.configs.upsertTcgapi({
        storeId: req.user!.storeId,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        actorId: req.user!.id,
        actorIp: req.ip,
      });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/integrations/tcgapi/verify',
    asyncHandler(async (req, res) => {
      try {
        const creds = await c.configs.getTcgapi(req.user!.storeId);
        const client = new TcgapiClient({ baseUrl: creds.baseUrl, apiKey: creds.apiKey });
        // Cheapest authenticated call.
        await client.listGames({ page: 1, perPage: 1 });
        await c.configs.markTcgapiVerified(req.user!.storeId, req.user!.id, req.ip);
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ ok: false, error: (err as Error).message });
      }
    }),
  );

  /**
   * Onboarding-only variant of the TCGapi upsert.
   * No password step-up required — the user just authenticated moments ago
   * during signup. Only accepted while `onboarding_completed_at IS NULL` to
   * prevent reuse as a permanent step-up bypass.
   */
  r.put(
    '/integrations/tcgapi/onboarding',
    asyncHandler(async (req, res) => {
      const body = TcgapiOnboardingUpsert.parse(req.body ?? {});

      const onboarding = await getOnboardingStatus(c.db, req.user!.storeId);
      if (onboarding.completedAt) {
        throw Forbidden('onboarding already completed; use the regular settings endpoint');
      }

      const existing = await c.configs.getTcgapiStatus(req.user!.storeId);
      if (!existing.configured && !body.apiKey) {
        throw BadRequest('apiKey is required when configuring TCGapi.dev for the first time');
      }

      await c.configs.upsertTcgapi({
        storeId: req.user!.storeId,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        actorId: req.user!.id,
        actorIp: req.ip,
      });
      res.json({ ok: true });
    }),
  );

  // ---- Clover -------------------------------------------------------------

  r.put(
    '/integrations/pos',
    asyncHandler(async (req, res) => {
      const body = PosUpsert.parse(req.body ?? {});
      await assertStepUp(c, req.user!.id, body.password);

      const existing = await c.configs.getPosStatus(req.user!.storeId);
      if (!existing.configured && (!body.accessToken || !body.webhookSigningSecret)) {
        throw BadRequest(
          'accessToken and webhookSigningSecret are required when configuring Clover for the first time',
        );
      }

      await c.configs.upsertPos({
        storeId: req.user!.storeId,
        baseUrl: body.baseUrl,
        merchantId: body.merchantId,
        accessToken: body.accessToken,
        webhookSigningSecret: body.webhookSigningSecret,
        actorId: req.user!.id,
        actorIp: req.ip,
      });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/integrations/pos/verify',
    asyncHandler(async (req, res) => {
      try {
        const creds = await c.configs.getPos(req.user!.storeId);
        // GET /v3/merchants/:id — works on sandbox + prod, costs ~nothing.
        const url = `${creds.baseUrl.replace(/\/$/, '')}/v3/merchants/${encodeURIComponent(creds.merchantId)}`;
        const upstream = await fetch(url, {
          headers: { Authorization: `Bearer ${creds.accessToken}` },
        });
        if (!upstream.ok) {
          const text = await upstream.text();
          return res
            .status(400)
            .json({ ok: false, error: `clover ${upstream.status}: ${text.slice(0, 200)}` });
        }
        await c.configs.markPosVerified(req.user!.storeId, req.user!.id, req.ip);
        // Silence unused-var lint for the imported CloverClient. We import it
        // for type completeness elsewhere; this endpoint goes direct so we
        // can return a structured error without throwing.
        void CloverClient;
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ ok: false, error: (err as Error).message });
      }
    }),
  );

  return r;
}

async function assertStepUp(c: Container, userId: string, password: string): Promise<void> {
  // In non-production, auth is just the x-tcg-dev-user header — there is no
  // real session to step up from, so password re-entry is pointless friction.
  if (process.env.NODE_ENV !== 'production') return;
  const [row] = await c.db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row) throw NotFound('user not found');
  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) throw Forbidden('password verification failed');
}
