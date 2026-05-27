import type { NextFunction, Request, Response } from 'express';
import passport from 'passport';
import type { UserRole } from '@tcg/shared';
import { Forbidden, Unauthorized } from '../../common/http-errors';
import { isProd } from '../../config/env';
import type { AuthenticatedUser } from './types';

/**
 * Require a valid JWT (Authorization: Bearer). In non-production environments,
 * the legacy `x-tcg-dev-user` header shortcut is also accepted so the React
 * PWA can run without first logging in. Production rejects the dev header.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!isProd()) {
    const devHeader = req.header('x-tcg-dev-user');
    if (devHeader) {
      try {
        const parsed = JSON.parse(devHeader) as Partial<AuthenticatedUser>;
        if (parsed?.id && parsed.storeId && parsed.role && parsed.email) {
          req.user = {
            id: parsed.id,
            storeId: parsed.storeId,
            role: parsed.role,
            email: parsed.email,
            displayName: parsed.displayName ?? parsed.email,
          };
          return next();
        }
      } catch {
        // fall through to JWT
      }
    }
  }
  passport.authenticate('jwt', { session: false }, (err: Error | null, user: AuthenticatedUser | false) => {
    if (err) return next(err);
    if (!user) return next(Unauthorized());
    req.user = user;
    next();
  })(req, _res, next);
}

/** Reject unless the authenticated user has one of the given roles. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(Unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(Forbidden(`requires one of: ${roles.join(', ')}`));
    }
    next();
  };
}
