import { Router } from 'express';
import { z } from 'zod';
import { CARD_CONDITIONS, CARD_LANGUAGES, CARD_PRINTINGS } from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest } from '../../common/http-errors';
import type { Container } from '../container';
import { requireAuth } from '../auth/middleware';

const ImageBody = z.object({
  dataUrl: z.string().trim().min(1).max(1_050_000),
});

// Money ceiling shared by the price fields — $100,000 in cents, well above any
// realistic single-card price while still rejecting absurd input.
const MAX_PRICE_CENTS = 100_000_00;

// Add a scanned/identified card straight into inventory as a raw single.
const QuickAddBody = z.object({
  pkmnpricesCardId: z.coerce.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200),
  setName: z.string().trim().max(200).optional(),
  setId: z.string().trim().max(64).optional(),
  cardNumber: z.string().trim().max(32).optional(),
  rarity: z.string().trim().max(64).optional(),
  imageUrl: z.string().trim().max(2048).optional(),
  locationId: z.string().uuid(),
  quantity: z.coerce.number().int().positive().max(999).default(1),
  condition: z.enum(CARD_CONDITIONS).default('NM'),
  printing: z.enum(CARD_PRINTINGS).default('Normal'),
  language: z.enum(CARD_LANGUAGES).default('EN'),
  sellPriceCents: z.coerce.number().int().min(0).max(MAX_PRICE_CENTS),
  marketPriceCents: z.coerce.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
});

export function productsRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/search',
    asyncHandler(async (req, res) => {
      const q = (req.query.q as string | undefined) ?? '';
      const pageRaw = Number(req.query.page ?? 1);
      const pageSizeRaw = Number(req.query.pageSize ?? 25);
      const sortRaw = String(req.query.sort ?? 'name_asc');
      const sort =
        sortRaw === 'price_desc' || sortRaw === 'price_asc' || sortRaw === 'name_asc'
          ? sortRaw
          : 'name_asc';
      const setName = (req.query.set as string | undefined) ?? '';
      const rarity = (req.query.rarity as string | undefined) ?? '';
      const game = (req.query.game as string | undefined) ?? '';
      const language = (req.query.language as string | undefined) ?? '';
      const artist = (req.query.artist as string | undefined) ?? '';
      const includeParseDebugRaw = (req.query.includeParseDebug as string | undefined) ?? '';
      const includeParseDebug =
        includeParseDebugRaw === '1' || includeParseDebugRaw.toLowerCase() === 'true';

      const out = await c.products.search(req.user!.storeId, {
        query: q,
        page: Number.isFinite(pageRaw) ? pageRaw : 1,
        pageSize: Number.isFinite(pageSizeRaw) ? pageSizeRaw : 25,
        sort,
        setName,
        rarity,
        game,
        language,
        artist,
        includeParseDebug,
      });
      res.json(out);
    }),
  );

  r.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = await c.products.findById(req.user!.storeId, req.params.id);
      res.json(row);
    }),
  );

  r.get(
    '/:id/skus',
    asyncHandler(async (req, res) => {
      const rows = await c.products.listSkus(req.user!.storeId, req.params.id);
      res.json({ skus: rows });
    }),
  );

  r.put(
    '/:id/image',
    asyncHandler(async (req, res) => {
      const parsed = ImageBody.safeParse(req.body);
      if (!parsed.success) {
        throw BadRequest('Invalid image payload.', parsed.error.flatten());
      }
      const out = await c.products.setImageDataUrl(
        req.user!.storeId,
        req.params.id,
        parsed.data.dataUrl,
      );
      res.json(out);
    }),
  );

  r.delete(
    '/:id/image',
    asyncHandler(async (req, res) => {
      const out = await c.products.clearImage(req.user!.storeId, req.params.id);
      res.json(out);
    }),
  );

  // Quick-add a scanned card to inventory: create (or reuse) the product + a
  // raw SKU, then receive an initial quantity at the operator's sell price.
  // Used by the camera "snap-to-identify" flow when the card isn't stocked yet.
  r.post(
    '/quick-add',
    asyncHandler(async (req, res) => {
      const parsed = QuickAddBody.safeParse(req.body);
      if (!parsed.success) {
        throw BadRequest('Invalid quick-add payload.', parsed.error.flatten());
      }
      const b = parsed.data;
      const storeId = req.user!.storeId;

      // Prefer the pkmnprices card id as the stable product key so a later
      // scan of the same card reuses this product. Fall back to a synthetic
      // identity when the card wasn't matched to the catalog.
      const tcgapiProductId = b.pkmnpricesCardId
        ? String(b.pkmnpricesCardId)
        : `manual:${[b.name, b.setName ?? '', b.cardNumber ?? ''].join('|').toLowerCase()}`;

      const { productId, skuId, skuCreated } = await c.products.quickAddSku(storeId, {
        tcgapiProductId,
        pkmnpricesProductId: b.pkmnpricesCardId ?? null,
        name: b.name,
        setName: b.setName ?? null,
        setId: b.setId ?? null,
        cardNumber: b.cardNumber ?? null,
        rarity: b.rarity ?? null,
        imageSourceUrl: b.imageUrl ?? null,
        condition: b.condition,
        printing: b.printing,
        language: b.language,
      });

      await c.inventory.receive({
        storeId,
        skuId,
        locationId: b.locationId,
        qty: b.quantity,
        costCents: 0,
        // receive() sets the current sell price from this value; the operator's
        // chosen price is prefilled from PkmnPrices market in the UI.
        marketPriceCents: b.sellPriceCents,
      });

      res.status(201).json({ productId, skuId, skuCreated, quantity: b.quantity });
    }),
  );

  return r;
}
