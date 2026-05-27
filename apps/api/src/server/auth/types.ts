import type { UserRole } from '@tcg/shared';

export interface AuthenticatedUser {
  id: string;
  storeId: string;
  role: UserRole;
  email: string;
  displayName: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

export {};
