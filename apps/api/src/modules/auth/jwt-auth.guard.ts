import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { UserRole } from '@tcg/shared';

export interface AuthenticatedUser {
  id: string;
  storeId: string;
  role: UserRole;
  email: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

export const ROLES_KEY = 'tcg.roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Skeleton JWT auth guard. In a real deployment plug in your verifier
 * (e.g. `jose.jwtVerify`) and load the user from `users` table.
 *
 * For local development we accept a trust-header `x-tcg-dev-user` containing
 * a JSON-encoded {@link AuthenticatedUser} so the rest of the system is
 * runnable without an external IdP.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = this.resolveUser(req);
    if (!user) {
      throw new UnauthorizedException('Missing or invalid credentials');
    }
    req.user = user;

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(user.role)) {
      throw new UnauthorizedException(`Requires one of roles: ${requiredRoles.join(', ')}`);
    }
    return true;
  }

  private resolveUser(req: Request): AuthenticatedUser | null {
    // Dev shortcut for local testing only.
    if (process.env.NODE_ENV !== 'production') {
      const header = req.header('x-tcg-dev-user');
      if (header) {
        try {
          return JSON.parse(header) as AuthenticatedUser;
        } catch {
          return null;
        }
      }
    }

    const auth = req.header('authorization');
    if (!auth?.startsWith('Bearer ')) return null;
    // TODO: integrate jose/auth.js verifier here.
    // Returning null forces a 401 in production until wired up.
    return null;
  }
}
