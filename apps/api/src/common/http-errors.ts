/**
 * Typed HTTP error class. Throw from any route or service; the global
 * `errorHandler` middleware translates it into a JSON response.
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const BadRequest = (m: string, details?: unknown) => new HttpError(400, m, details);
export const Unauthorized = (m = 'unauthorized') => new HttpError(401, m);
export const Forbidden = (m = 'forbidden') => new HttpError(403, m);
export const NotFound = (m = 'not found') => new HttpError(404, m);
export const Conflict = (m: string, details?: unknown) => new HttpError(409, m, details);
export const TooManyRequests = (m = 'rate limit exceeded', retryAfterMs?: number) =>
  new HttpError(429, m, retryAfterMs != null ? { retryAfterMs } : undefined);
