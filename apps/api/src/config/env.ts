/**
 * Centralized environment configuration. Parsed once at boot so failures are
 * caught immediately and the rest of the app can rely on the resulting object
 * being valid.
 */
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().optional(),
  PG_SSL_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).optional(),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  // Header name Clover uses to deliver the HMAC signature on inbound webhooks.
  // Defaults to the conventional `X-Clover-Signature`; older app integrations
  // send `X-Clover-Auth`. Override here if the merchant's app uses something else.
  CLOVER_WEBHOOK_SIGNATURE_HEADER: z.string().default('x-clover-signature'),
  JWT_ISSUER: z.string().default('tcg-toolkit'),
  JWT_AUDIENCE: z.string().default('tcg-toolkit-api'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REFRESH_COOKIE_NAME: z.string().default('tcg_refresh'),
  COOKIE_DOMAIN: z.string().optional(),

  TCGAPI_BASE_URL: z.string().default('https://api.tcgapi.dev/v1'),
  TCGAPI_KEY: z.string().optional(),

  CLOVER_BASE_URL: z.string().default('https://sandbox.dev.clover.com'),
  CLOVER_ACCESS_TOKEN: z.string().optional(),
  CLOVER_MERCHANT_ID: z.string().optional(),
  CLOVER_WEBHOOK_SIGNING_SECRET: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof Env>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function isProd(): boolean {
  return loadEnv().NODE_ENV === 'production';
}
