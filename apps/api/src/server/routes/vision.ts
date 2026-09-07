/**
 * Camera "snap-to-identify" endpoint for the Buy / Sell / Trade tabs.
 *
 *   GET  /vision/status              → { enabled, pricingConfigured }
 *   POST /vision/identify-card       → { identification, candidates, pricingConfigured }
 *
 * Flow: the client posts a card photo (data URL); a multimodal model reads the
 * card's printed identity; that identity is fed straight into the existing
 * PkmnPrices search so the operator gets real priced candidates (with variants
 * available via the existing `/pkmnprices/cards/:id/prices`). The operator
 * confirms a candidate in the UI before anything is added to a transaction —
 * this endpoint never mutates inventory.
 *
 * Cost control: vision calls hit a paid LLM, so the route has its own tight
 * rate limiter on top of auth.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest, HttpError } from '../../common/http-errors';
import { VisionNotConfiguredError } from '../../integrations/vision/client';
import type { PkmnpricesCardSummary } from '../../integrations/pkmnprices/client';
import { requireAuth } from '../auth/middleware';
import type { Container } from '../container';

// Mirrors the card shape the trade UI already consumes from
// `/pkmnprices/search`, so the confirmation panel can reuse the same rendering
// and the same `/pkmnprices/cards/:id/prices` follow-up call for variants.
interface TcgapiCardShape {
  id: string;
  name: string;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  setId: string | null;
  setName: string | null;
  artist: string | null;
  gameSlug: 'pokemon';
  gameName: 'Pokémon';
}

// Accept only inline image data URLs, capped to keep a rogue/huge upload from
// reaching the model. ~1.05 MB of base64 ≈ ~780 KB of image, matching the
// product image upload limit.
const IdentifyBody = z.object({
  dataUrl: z
    .string()
    .trim()
    .min(1)
    .max(1_050_000)
    .refine((v) => /^data:image\/(png|jpe?g|webp|heic|heif);base64,/i.test(v), {
      message: 'dataUrl must be a base64-encoded image data URL',
    }),
});

const CANDIDATE_LIMIT = 12;

export function visionRouter(c: Container): Router {
  const r = Router();
  r.use(requireAuth);

  // Small budget: identification is expensive and operator-driven, so a burst
  // of ~20/min per IP is plenty while still throttling accidental loops.
  const identifyLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true });

  r.get(
    '/status',
    asyncHandler(async (req, res) => {
      const pricing = await c.configs.getPkmnpricesStatus(req.user!.storeId);
      res.json({
        enabled: c.vision.isEnabled(),
        pricingConfigured: pricing.configured && pricing.hasKey,
      });
    }),
  );

  r.post(
    '/identify-card',
    identifyLimiter,
    asyncHandler(async (req, res) => {
      if (!c.vision.isEnabled()) {
        throw new HttpError(503, 'Vision card identification is not configured on this server.');
      }

      const parsed = IdentifyBody.safeParse(req.body);
      if (!parsed.success) {
        throw BadRequest('Invalid image payload.', parsed.error.flatten());
      }

      let identification;
      try {
        identification = await c.vision.identifyCard(parsed.data.dataUrl);
      } catch (err) {
        if (err instanceof VisionNotConfiguredError) {
          throw new HttpError(503, err.message);
        }
        // Upstream/transport failure — surface as a bad-gateway so the client
        // can offer a retry without treating it as a client error.
        throw new HttpError(502, 'Card identification failed. Please try again.');
      }

      if (!identification) {
        // Model could not read a card; return a 200 with an empty result so the
        // UI can prompt the operator to retake the photo rather than erroring.
        res.json({ identification: null, candidates: [], pricingConfigured: false });
        return;
      }

      const pricing = await c.configs.getPkmnpricesStatus(req.user!.storeId);
      const pricingConfigured = pricing.configured && pricing.hasKey;

      let candidates: TcgapiCardShape[] = [];
      if (pricingConfigured) {
        const client = await c.pkmnpricesFor(req.user!.storeId);
        const number = normalizeNumber(identification.number);
        const page = await client.searchCards({
          name: identification.name,
          number,
          per_page: CANDIDATE_LIMIT,
          page: 1,
        });
        candidates = page.results.map(mapCardToTcgapiShape);
      }

      res.json({ identification, candidates, pricingConfigured });
    }),
  );

  return r;
}

// PkmnPrices' `number` filter matches the printed left-hand collector number
// ("4/102" → "4"). Passing the full fraction returns zero rows, so strip it.
function normalizeNumber(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const left = raw.split('/')[0]?.trim();
  return left ? left : undefined;
}

function mapCardToTcgapiShape(c: PkmnpricesCardSummary): TcgapiCardShape {
  return {
    id: String(c.id),
    name: c.name,
    number: c.number,
    rarity: c.rarity,
    imageUrl: c.imageUrl,
    setId: c.setId != null ? String(c.setId) : null,
    setName: c.setName,
    artist: c.artist ?? null,
    gameSlug: 'pokemon',
    gameName: 'Pokémon',
  };
}
