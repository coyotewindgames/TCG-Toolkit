import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * Webhook handlers need the exact bytes the provider signed for HMAC
 * verification. Mount this on `/webhooks/*` before `express.json()`.
 *
 * After the raw buffer is captured, we re-parse JSON ourselves so the handler
 * can still consume `req.body` as an object.
 */
export const rawJsonBody = [
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req: Request, _res: Response, next: NextFunction): void => {
    const buf = req.body as Buffer | undefined;
    if (Buffer.isBuffer(buf)) {
      (req as Request & { rawBody: Buffer }).rawBody = buf;
      if (buf.length === 0) {
        req.body = {};
      } else {
        try {
          req.body = JSON.parse(buf.toString('utf8'));
        } catch {
          req.body = {};
        }
      }
    }
    next();
  },
];
