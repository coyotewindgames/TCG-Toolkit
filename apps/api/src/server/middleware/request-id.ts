import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/** Attach a stable `X-Request-Id` for log correlation. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = req.header('x-request-id') ?? randomUUID();
  (req as Request & { id: string }).id = id;
  res.setHeader('x-request-id', id);
  next();
}
