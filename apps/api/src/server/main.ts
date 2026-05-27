import { createServer } from 'node:http';
import { loadEnv } from '../config/env';
import { createApp } from './app';
import { initRealtime } from './realtime/socket';

async function main() {
  const env = loadEnv();
  const app = createApp();
  const http = createServer(app);
  await initRealtime(http);

  http.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[api] ${signal} received, shutting down`);
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[api] fatal startup error', err);
  process.exit(1);
});
