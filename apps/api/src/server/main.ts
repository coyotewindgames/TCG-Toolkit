import { createServer } from 'node:http';
import { loadEnv } from '../config/env';
import { getLogger } from '../common/logger';
import { createApp } from './app';
import { closeRealtime, initRealtime } from './realtime/socket';
import { closeRedis } from './redis';
import { getPool } from '../db/client';

async function main() {
  const env = loadEnv();
  const log = getLogger();
  const app = createApp();
  const http = createServer(app);
  await initRealtime(http);

  http.listen(env.PORT, env.HOST, () => {
    log.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, 'api listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown initiated');
    const hardStop = setTimeout(() => {
      log.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    hardStop.unref();

    (async () => {
      try {
        await new Promise<void>((resolve) => http.close(() => resolve()));
        await closeRealtime();
        await closeRedis();
        await getPool().end();
        log.info('graceful shutdown complete');
        process.exit(0);
      } catch (err) {
        log.error({ err }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  getLogger().fatal({ err }, 'fatal startup error');
  process.exit(1);
});
