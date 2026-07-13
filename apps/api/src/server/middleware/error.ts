import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { HttpError } from '../../common/http-errors';

/** 404 fallback — only reached when nothing else matched. */
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not found' });
}

/** Global error handler. Must be the last middleware. */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const reqId = (req as Request & { id?: string }).id;

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      details: err.details ?? undefined,
      requestId: reqId,
    });
    return;
  }

  // Drizzle / pg unique violation
  const code = (err as { code?: string } | null)?.code;
  if (code === '23505') {
    res.status(409).json({ error: 'duplicate', requestId: reqId });
    return;
  }

  // Third-party SDK rate-limit errors (e.g. PkmnPricesError with status 429).
  // Duck-type the check so we don't import the SDK class here.
  const sdkStatus = (err as { status?: number } | null)?.status;
  if (sdkStatus === 429) {
    const retryAfterMs = (err as { retryAfterMs?: number } | null)?.retryAfterMs;
    const headers: Record<string, string> = { 'Retry-After': '60' };
    if (retryAfterMs != null && retryAfterMs > 0) {
      headers['Retry-After'] = String(Math.ceil(retryAfterMs / 1000));
    }
    res.set(headers).status(429).json({
      error: 'rate_limit_exceeded',
      message: err instanceof Error ? err.message : 'rate limit exceeded',
      retryAfterMs: retryAfterMs ?? 60_000,
      requestId: reqId,
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  const message = err instanceof Error ? err.message : 'internal error';
  res.status(500).json({ error: 'internal_error', message, requestId: reqId });
};
