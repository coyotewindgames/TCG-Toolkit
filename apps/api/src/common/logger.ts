/**
 * Shared pino logger. Use instead of `console.*` so structured logs flow into
 * the same sinks (pino-http for requests, this for everything else) and `LOG_LEVEL`
 * is honoured.
 */
import pino, { type Logger } from 'pino';
import { loadEnv } from '../config/env';

let logger: Logger | null = null;

export function getLogger(): Logger {
  if (!logger) {
    const env = loadEnv();
    logger = pino({
      level: env.LOG_LEVEL,
      base: { service: 'tcg-api', env: env.NODE_ENV },
    });
  }
  return logger;
}
