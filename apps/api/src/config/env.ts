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
  /**
   * 32-byte key (base64 or hex) used by the vault to encrypt third-party
   * credentials stored in Postgres (Clover access tokens, TCGapi keys, etc.).
   * Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   *
   * Treat as a root secret: rotating it requires re-encrypting every row in
   * `tcgapi_configs` and `pos_configs`.
   */
  CONFIG_ENCRYPTION_KEY: z.string().min(32, 'CONFIG_ENCRYPTION_KEY must be a 32-byte key (base64 or hex)'),
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

  // Integration credentials (TCGapi.dev, Clover) are stored encrypted in
  // Postgres per store and managed via the settings UI. See `vault.ts` and
  // `config-service.ts`. The legacy env vars `TCGAPI_KEY`, `CLOVER_*` are
  // honoured only by `scripts/seed-configs-from-env.ts` for first-boot import.

  // Email delivery (used by the password-reset flow). If RESEND_API_KEY is
  // unset, the app logs reset links to the server console instead — fine for
  // dev, surfaces a warning in production. MAIL_FROM must be a sender that
  // your Resend account is allowed to send from.
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  /**
   * Public base URL of the web app, used to render absolute links in emails
   * (e.g. password reset). Defaults to localhost for dev.
   */
  APP_BASE_URL: z.string().default('http://localhost:5173'),

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
