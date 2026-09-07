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
  '(string or null, the expansion/set name if legible), "number" (string or ' +
  'null, the collector number if legible, e.g. "4/102"), "language" (string or ' +
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
          temperature: 0,
          max_tokens: 300,
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
