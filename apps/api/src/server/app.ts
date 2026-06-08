import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import passport from 'passport';
import pinoHttp from 'pino-http';
import { loadEnv } from '../config/env';
import { configurePassport } from './auth/strategies';
import { authRouter } from './auth/routes';
import { buildContainer } from './container';
import { errorHandler, notFound } from './middleware/error';
import { rawJsonBody } from './middleware/raw-body';
import { requestId } from './middleware/request-id';
import { healthRouter } from './routes/health';
import { inventoryRouter } from './routes/inventory';
import { locationsRouter } from './routes/locations';
import { ordersRouter } from './routes/orders';
import { productsRouter } from './routes/products';
import { scansRouter } from './routes/scans';
import { settingsRouter } from './routes/settings';
import { skusRouter, barcodesRouter } from './routes/skus';
import { tcgapiRouter } from './routes/tcgapi';
import { tradeinsRouter } from './routes/tradeins';
import { webhooksRouter } from './routes/webhooks';

/** Build a fully-wired Express application. Exported for tests + main. */
export function createApp(): Express {
  const env = loadEnv();
  const app = express();
  const container = buildContainer();

  configurePassport();

  app.disable('x-powered-by');
  // Trust the first proxy hop (Render/Cloudflare load balancer). Using a
  // specific number instead of `true` satisfies express-rate-limit's
  // anti-spoofing check (ERR_ERL_PERMISSIVE_TRUST_PROXY).
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      level: env.LOG_LEVEL,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
    }),
  );
  app.use(helmet());
  // CORS: in production we never reflect `*` with credentials. Operators must
  // configure an explicit comma-separated list of trusted origins; the wildcard
  // is only honoured outside production.
  const corsOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  const allowAny = corsOrigins.includes('*');
  if (allowAny && env.NODE_ENV === 'production') {
    throw new Error('CORS_ORIGIN cannot be "*" in production');
  }
  app.use(
    cors({
      origin: allowAny ? true : corsOrigins,
      credentials: !allowAny,
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(passport.initialize());

  // Webhook raw-body capture MUST come before the JSON parser.
  app.use('/webhooks', rawJsonBody);
  // Inventory CSV imports are posted as JSON text payloads and can be
  // substantially larger in production than local test files.
  app.use(express.json({ limit: '60mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Auth gets its own rate limiter to slow credential stuffing. The refresh
  // cookie is scoped to `/api/auth`, so we mount the auth router on that path
  // only to keep cookie scope and request paths in lockstep.
  const authLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true });
  app.use('/api/auth', authLimiter, authRouter);

  app.use(healthRouter());
  for (const prefix of ['', '/api']) {
    app.use(`${prefix}/products`, productsRouter(container));
    app.use(`${prefix}/inventory`, inventoryRouter(container));
    app.use(`${prefix}/locations`, locationsRouter(container));
    app.use(`${prefix}/scans`, scansRouter(container));
    app.use(`${prefix}/orders`, ordersRouter(container));
    app.use(`${prefix}/tradeins`, tradeinsRouter(container));
    app.use(`${prefix}/skus`, skusRouter(container));
    app.use(`${prefix}/settings`, settingsRouter(container));
    app.use(`${prefix}/tcgapi`, tcgapiRouter(container));
    app.use(`${prefix}/barcodes`, barcodesRouter(container));
  }
  // Webhooks intentionally mount only at /webhooks (no /api prefix) so the
  // raw-body middleware path stays in lockstep with the registered routes.
  app.use('/webhooks', webhooksRouter(container));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
