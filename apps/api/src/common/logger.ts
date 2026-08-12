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
    logger = pino(loggerOptions());
  }
  return logger;
}

/**
 * Falls back to bare defaults when the environment has not been configured
 * (unit tests, one-off scripts) so logging never becomes the reason a code path
 * fails.
 */
function loggerOptions(): pino.LoggerOptions {
  try {
    const env = loadEnv();
    return { level: env.LOG_LEVEL, base: { service: 'tcg-api', env: env.NODE_ENV } };
  } catch {
    return { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'tcg-api' } };
  }
}

/**
 * Logger for work done on behalf of an HTTP request. `pino-http` attaches a
 * request-scoped child logger (with the request id) to `req.log`; fall back to
 * the process logger when called outside a request (jobs, scripts, tests).
 */
export function requestLogger(req: { log?: Logger }): Logger {
  return req.log ?? getLogger();
}

/** Logger for a background job or one-off task, tagged with the job name. */
export function jobLogger(job: string): Logger {
  return getLogger().child({ job });
}
