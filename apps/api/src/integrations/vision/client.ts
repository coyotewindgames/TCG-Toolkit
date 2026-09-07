/**
 * Vision card identifier: reads a photo of a trading card and extracts its
 * printed identity (name / set / number / language / printing) using a
 * multimodal LLM. The structured result is handed to the PkmnPrices search so
 * the operator gets real pricing and variants for the card they just snapped.
 *
 * Provider-agnostic on purpose: the default target is the OpenAI-compatible
 * Chat Completions API (works for OpenAI and Azure/gateway deployments), but
 * the rest of the app only depends on `VisionCardIdentifier`, so swapping the
 * backing model is a config change, not a code change.
 *
 * This is a *platform-level* capability (one key in env, shared by every
 * store) rather than a per-store integration, because the store operator is
 * not expected to bring their own vision subscription. When no key is
 * configured, `isEnabled()` is false and the route returns a clean error.
 */
import { z } from 'zod';
import { getLogger } from '../../common/logger';

/** Structured identity extracted from a card photo. Money-free; downstream
 * search turns this into priced candidates. */
export interface VisionCardIdentification {
  /** Card name as printed (e.g. "Charizard"). Required — the primary search key. */
  name: string;
  /** Set/expansion name if legible (e.g. "Base Set", "Obsidian Flames"). */
  setName: string | null;
  /** Printed set code / abbreviation near the number (e.g. "PBL", "OBF",
   * "SV3"). Far more reliably legible than the set logo, so it's the best
   * signal for which set a card belongs to. */
  setCode: string | null;
  /** Collector number if legible (e.g. "4/102", "025"). */
  number: string | null;
  /** Language of the card face (e.g. "English", "Japanese"). */
  language: string | null;
  /** Printing/variant hint if discernible (e.g. "Holo", "Reverse", "1st Edition"). */
  printingHint: string | null;
  /** Model self-reported confidence in the identification, 0..1. */
  confidence: number;
}

export interface VisionClientConfig {
  provider: 'openai';
  apiKey?: string;
  model: string;
  baseUrl: string;
  timeoutMs?: number;
}

/** Zod guard for the JSON the model is asked to return. Keeps a hallucinated
 * or malformed response from propagating past this boundary. */
const IdentificationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  setName: z.string().trim().max(160).nullable().optional(),
  setCode: z.string().trim().max(24).nullable().optional(),
  number: z.string().trim().max(32).nullable().optional(),
  language: z.string().trim().max(32).nullable().optional(),
  printingHint: z.string().trim().max(48).nullable().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
});

const SYSTEM_PROMPT =
  'You identify trading cards (primarily Pokémon TCG) from a single photo. ' +
  'Read only the text and art actually visible on the card. Do not guess a card ' +
  'that is not shown. Respond with a single JSON object and nothing else, using ' +
  'exactly these keys: "name" (string, the card name as printed), "setName" ' +
  '(string or null, the expansion/set name — note this is usually shown only as ' +
  'a small set symbol/logo, not text, so return null unless the set name is ' +
  'actually printed), "setCode" (string or null, the small printed set ' +
  'abbreviation near the collector number, e.g. "PBL", "OBF", "SV3", "151", ' +
  '"MEW" — this is printed TEXT and is the most reliable set indicator, so read ' +
  'it carefully when present), "number" (string or ' +
  'null, the collector number exactly as printed in the small text near the ' +
  'bottom-left or bottom-right corner, usually a fraction like "102/084" or ' +
  '"4/102" — copy both parts precisely; the left value may be larger than the ' +
  'right on special/secret rares, and never invent a number you cannot read), ' +
  '"language" (string or ' +
  'null, e.g. "English" or "Japanese"), "printingHint" (string or null, e.g. ' +
  '"Holo", "Reverse", "1st Edition", or null if a normal card), and "confidence" ' +
  '(number between 0 and 1 for how sure you are of the name). If no card is ' +
  'clearly visible, return {"name":"","confidence":0}.';

/** Thrown when identification is attempted while the feature is unconfigured. */
export class VisionNotConfiguredError extends Error {
  override readonly name = 'VisionNotConfiguredError';
  constructor() {
    super('Vision card identification is not configured on this server.');
  }
}

export class VisionCardIdentifier {
  private readonly log = getLogger();
  private readonly timeoutMs: number;

  constructor(private readonly config: VisionClientConfig) {
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  /** Whether a usable API key is present. The route uses this to return a
   * clear "not configured" error and the UI uses the same signal (via a
   * capability flag) to hide the camera button. */
  isEnabled(): boolean {
    return Boolean(this.config.apiKey);
  }

  /**
   * Identify a card from an image data URL (`data:image/...;base64,...`).
   *
   * Returns `null` when the model reports it cannot see a card (empty name or
   * zero confidence); throws `VisionNotConfiguredError` when disabled and a
   * generic `Error` on upstream/transport failure so the route can map it to a
   * 502.
   */
  async identifyCard(imageDataUrl: string): Promise<VisionCardIdentification | null> {
    if (!this.config.apiKey) throw new VisionNotConfiguredError();

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          ...buildModelParams(this.config.model),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Identify this trading card.' },
                { type: 'image_url', image_url: { url: imageDataUrl } },
              ],
            },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`vision provider error (${res.status}): ${body.slice(0, 500)}`);
      }

      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = payload.choices?.[0]?.message?.content ?? '';
      const parsed = this.parseContent(content);

      this.log.info(
        {
          source: 'vision',
          endpoint: 'chat.completions',
          model: this.config.model,
          durationMs: Date.now() - started,
          identified: Boolean(parsed && parsed.name),
          confidence: parsed?.confidence ?? null,
        },
        'vision identifyCard',
      );

      if (!parsed || !parsed.name || parsed.confidence <= 0) return null;
      return parsed;
    } catch (err) {
      if (err instanceof VisionNotConfiguredError) throw err;
      if (controller.signal.aborted) {
        throw new Error(`vision provider timed out after ${this.timeoutMs}ms`);
      }
      throw err instanceof Error ? err : new Error('vision provider failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse and validate the model's JSON content into a normalized shape.
   * Tolerates the model wrapping JSON in prose or code fences. */
  private parseContent(content: string): VisionCardIdentification | null {
    const json = extractJsonObject(content);
    if (!json) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return null;
    }
    const result = IdentificationSchema.safeParse(raw);
    if (!result.success) return null;
    const d = result.data;
    return {
      name: d.name.trim(),
      setName: d.setName?.trim() || null,
      setCode: d.setCode?.trim() || null,
      number: d.number?.trim() || null,
      language: d.language?.trim() || null,
      printingHint: d.printingHint?.trim() || null,
      confidence: d.confidence ?? 0,
    };
  }
}

/** Pull the first balanced `{...}` JSON object out of a string, ignoring any
 * surrounding prose or ```json fences the model may add despite instructions. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The GPT-5 family and the reasoning (o-series) models changed the Chat
 * Completions contract vs gpt-4o:
 *   - token cap is `max_completion_tokens`, not `max_tokens` (the old key 400s);
 *   - `temperature` only accepts the default (1), so we must omit our `0`.
 * They also spend part of the token budget on hidden reasoning, so we give a
 * larger cap (and nudge `reasoning_effort` low) to guarantee room for the small
 * JSON answer. Older models keep the classic `max_tokens` + deterministic
 * `temperature: 0`. Detection is by model-id prefix so new snapshots inherit it.
 */
function isNextGenModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith('gpt-5') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4')
  );
}

function buildModelParams(model: string): Record<string, unknown> {
  if (isNextGenModel(model)) {
    return {
      max_completion_tokens: 1200,
      // Keep latency/cost down; 'minimal' is valid on gpt-5 chat completions.
      reasoning_effort: 'minimal',
    };
  }
  return {
    temperature: 0,
    max_tokens: 400,
  };
}
