/**
 * Tiny wrapper to forward async route handler errors to the global
 * `errorHandler` middleware without try/catch noise at every call site.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

type Handler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;

export function asyncHandler(fn: Handler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
