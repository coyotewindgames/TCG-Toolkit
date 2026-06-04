/**
 * Tenant-aware client session for the SPA.
 *
 * The data model:
 * - `user` and `accessToken` come from `/api/auth/login`, `/auth/signup`, or
 *   `/auth/refresh`. The token lives in memory only (refresh cookie is
 *   HttpOnly server-issued).
 * - `locationId` and `registerId` are operator choices for the current shift
 *   and persist in `localStorage`, scoped per-store so switching tenants
 *   doesn't bleed selections across.
 *
 * In dev-only, if `VITE_DEV_USER` is set as a JSON object the session boots
 * with that user as a "fake login" — replacing the old per-field VITE_DEV_*
 * cluster. Production never reads it.
 */
import type { UserRole } from '@tcg/shared';

export interface SessionUser {
  id: string;
  storeId: string;
  email: string;
  role: UserRole;
  displayName: string;
}

export interface SessionState {
  user: SessionUser | null;
  accessToken: string | null;
  locationId: string | null;
  registerId: string | null;
  /** True until the initial /auth/refresh round-trip resolves. */
  bootstrapping: boolean;
}

const LOC_KEY = (storeId: string) => `tcg.location.${storeId}`;
const REG_KEY = (storeId: string) => `tcg.register.${storeId}`;

const listeners = new Set<() => void>();
let state: SessionState = {
  user: null,
  accessToken: null,
  locationId: null,
  registerId: null,
  bootstrapping: true,
};

function emit() {
  for (const fn of listeners) fn();
}

export function getSession(): SessionState {
  return state;
}

export function subscribeSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function loadPerStorePrefs(storeId: string): { locationId: string | null; registerId: string | null } {
  if (typeof window === 'undefined') return { locationId: null, registerId: null };
  return {
    locationId: window.localStorage.getItem(LOC_KEY(storeId)),
    registerId: window.localStorage.getItem(REG_KEY(storeId)),
  };
}

export function setUser(user: SessionUser, accessToken: string): void {
  const { locationId, registerId } = loadPerStorePrefs(user.storeId);
  state = { user, accessToken, locationId, registerId, bootstrapping: false };
  emit();
}

export function setAccessToken(accessToken: string | null): void {
  state = { ...state, accessToken };
  emit();
}

export function clearSession(): void {
  state = { user: null, accessToken: null, locationId: null, registerId: null, bootstrapping: false };
  emit();
}

export function setBootstrapping(v: boolean): void {
  if (state.bootstrapping === v) return;
  state = { ...state, bootstrapping: v };
  emit();
}

export function setLocationId(locationId: string | null): void {
  if (!state.user) return;
  const key = LOC_KEY(state.user.storeId);
  if (locationId) window.localStorage.setItem(key, locationId);
  else window.localStorage.removeItem(key);
  state = { ...state, locationId };
  emit();
}

export function setRegisterId(registerId: string | null): void {
  if (!state.user) return;
  const key = REG_KEY(state.user.storeId);
  if (registerId) window.localStorage.setItem(key, registerId);
  else window.localStorage.removeItem(key);
  state = { ...state, registerId };
  emit();
}

/**
 * Dev-only escape hatch. Reads `VITE_DEV_USER` (JSON) and seeds the session
 * without any HTTP login. The api client will translate the lack of a real
 * token into the legacy `x-tcg-dev-user` header.
 */
export function tryDevUserBootstrap(): SessionUser | null {
  if (!import.meta.env.DEV) return null;
  const raw = (import.meta.env.VITE_DEV_USER as string | undefined)?.trim();
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as Partial<SessionUser>;
    if (!u.id || !u.storeId || !u.role || !u.email) return null;
    const user: SessionUser = {
      id: u.id,
      storeId: u.storeId,
      role: u.role,
      email: u.email,
      displayName: u.displayName ?? u.email,
    };
    const { locationId, registerId } = loadPerStorePrefs(user.storeId);
    state = { user, accessToken: null, locationId, registerId, bootstrapping: false };
    emit();
    return user;
  } catch {
    return null;
  }
}
