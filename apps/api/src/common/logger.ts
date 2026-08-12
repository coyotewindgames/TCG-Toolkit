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
