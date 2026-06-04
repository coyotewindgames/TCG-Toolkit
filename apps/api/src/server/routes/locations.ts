import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { CreateLocationRequest } from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { schema } from '../../db/client';
import type { Container } from '../container';
import { requireAuth, requireRole } from '../auth/middleware';
import { validateBody } from '../middleware/validate';

/**
 * Locations are scoped to the caller's store via the JWT-derived
 * `req.user.storeId` — never accept a storeId from the client. List is
 * available to any authenticated user; create requires `owner` or `manager`.
 */
export function locationsRouter(container: Container) {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const rows = await container.db
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.locations)
        .where(eq(schema.locations.storeId, req.user!.storeId))
        .orderBy(schema.locations.createdAt);
      res.json({ locations: rows });
    }),
  );

  router.post(
    '/',
    requireRole('owner', 'manager'),
    validateBody(CreateLocationRequest),
    asyncHandler(async (req, res) => {
      const [row] = await container.db
        .insert(schema.locations)
        .values({
          storeId: req.user!.storeId,
          name: (req.body as { name: string }).name.trim(),
        })
        .returning({ id: schema.locations.id, name: schema.locations.name });
      res.status(201).json(row);
    }),
  );

  return router;
}
