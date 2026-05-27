import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { BadRequest } from '../../common/http-errors';

/** Validate `req.body` against a Zod schema and replace it with the parsed value. */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(BadRequest('validation failed', result.error.issues));
    }
    req.body = result.data;
    next();
  };
}

/** Validate `req.query` against a Zod schema. */
export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(BadRequest('validation failed', result.error.issues));
    }
    (req as Request & { validatedQuery: T }).validatedQuery = result.data;
    next();
  };
}
