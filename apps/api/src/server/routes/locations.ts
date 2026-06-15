import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { CreateLocationRequest } from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest, NotFound } from '../../common/http-errors';
import { schema } from '../../db/client';
import type { Container } from '../container';
import { requireAuth, requireRole } from '../auth/middleware';
import { validateBody } from '../middleware/validate';

const PatchLocationRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  address: z
    .object({
      street: z.string().max(200).optional(),
      city: z.string().max(100).optional(),
      state: z.string().max(100).optional(),
      zip: z.string().max(20).optional(),
      country: z.string().max(100).optional(),
    })
    .optional(),
});

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

  /**
   * Update a location's name and/or address. Used by the onboarding wizard
   * to let the owner fill in their store address during setup.
   */
  router.patch(
    '/:id',
    requireRole('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const body = PatchLocationRequest.parse(req.body ?? {});
      if (!body.name && !body.address) throw BadRequest('provide name or address to update');

      const [existing] = await container.db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(
          and(
            eq(schema.locations.id, req.params.id),
            eq(schema.locations.storeId, req.user!.storeId),
          ),
        )
        .limit(1);
      if (!existing) throw NotFound('location not found');

      const [updated] = await container.db
        .update(schema.locations)
        .set({
          ...(body.name ? { name: body.name.trim() } : {}),
          ...(body.address !== undefined ? { address: body.address } : {}),
        })
        .where(eq(schema.locations.id, req.params.id))
        .returning({ id: schema.locations.id, name: schema.locations.name, address: schema.locations.address });
      res.json(updated);
    }),
  );

  return router;
}
