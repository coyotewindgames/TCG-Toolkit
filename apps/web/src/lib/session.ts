/**
 * Tenant-aware client session for the SPA.
 *
 * The data model:
 * - `user` and `accessToken` come from `/api/auth/login`, `/auth/signup`, or
 *   `/auth/refresh`. The token lives in memory only (refresh cookie is
 *   HttpOnly server-issued).
 * - `refreshToken` (for Capacitor native) is stored only via a
 *   `SecureTokenStore` adapter backed by the OS Keychain/Keystore. It is
 *   never written to `localStorage`. On browser the HttpOnly cookie is used
 *   instead and no refresh token is persisted at all.
 * - `locationId` and `registerId` are operator choices for the current shift
 *   and persist in `localStorage`, scoped per-store so switching tenants
 *   doesn't bleed selections across.
 *
 * In dev-only, if `VITE_DEV_USER` is set as a JSON object the session boots
 * with that user as a "fake login" — replacing the old per-field VITE_DEV_*
 * cluster. Production never reads it.
 */
import type { UserRole } from '@tcg/shared';

const AUTH_KEY = 'tcg.auth';
const AUTH_TTL_MS = 60 * 60 * 1000;

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
  refreshToken: string | null;
  locationId: string | null;
  registerId: string | null;
  sessionExpiresAt: number | null;
  /** True until the initial /auth/refresh round-trip resolves. */
  bootstrapping: boolean;
}

/**
 * Asynchronous secure-token adapter. Native apps (Capacitor) must register an
 * implementation backed by the OS Keychain/Keystore via `setSecureTokenStore`
 * before any auth call. The browser leaves this unset — the HttpOnly refresh
 * cookie is the secure credential there and no refresh token is persisted.
 */
export interface SecureTokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

let _secureStore: SecureTokenStore | null = null;
/** In-memory cache of the refresh token, pre-loaded from the secure store. */
let _cachedRefreshToken: string | null = null;
const SECURE_REFRESH_KEY = 'tcg.refreshToken';

export function setSecureTokenStore(store: SecureTokenStore): void {
  _secureStore = store;
}

/**
 * Must be called by native apps during startup (before any auth check) to
 * pre-populate the in-memory refresh token cache from the Keychain/Keystore.
 * After this call, `getSession().refreshToken` reflects the stored value.
 */
export async function preloadRefreshToken(): Promise<void> {
  if (!_secureStore) return;
  _cachedRefreshToken = await _secureStore.get(SECURE_REFRESH_KEY);
  if (_cachedRefreshToken !== state.refreshToken) {
    state = { ...state, refreshToken: _cachedRefreshToken };
    emit();
  }
}

function storeSecureRefreshToken(token: string): void {
  _cachedRefreshToken = token;
  void _secureStore?.set(SECURE_REFRESH_KEY, token);
}

function readSecureRefreshToken(): string | null {
  return _cachedRefreshToken;
}

function clearSecureRefreshToken(): void {
  _cachedRefreshToken = null;
  void _secureStore?.remove(SECURE_REFRESH_KEY);
}

/** localStorage record — never contains the refresh token. */
interface PersistedAuthSession {
  user: SessionUser;
  accessToken: string;
  sessionExpiresAt: number | null;
}

const LOC_KEY = (storeId: string) => `tcg.location.${storeId}`;
const REG_KEY = (storeId: string) => `tcg.register.${storeId}`;

const listeners = new Set<() => void>();
let state: SessionState = {
  user: null,
  accessToken: null,
  refreshToken: null,
  locationId: null,
  registerId: null,
  sessionExpiresAt: null,
  bootstrapping: true,
};

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function clearExpiryTimer(): void {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

/**
 * Called when the access-token TTL fires. Clears the access token and user
 * from memory and removes the main localStorage record, but does NOT touch
 * the secure-stored refresh token so a native client can still perform a
 * body-based refresh on next resume.
 */
function expireAccessToken(): void {
  clearExpiryTimer();
  clearPersistedAuthSession();
  state = {
    ...state,
    user: null,
    accessToken: null,
    sessionExpiresAt: null,
    bootstrapping: false,
  };
  emit();
}

function scheduleExpiry(sessionExpiresAt: number): void {
  clearExpiryTimer();
  const delay = Math.max(0, sessionExpiresAt - Date.now());
  expiryTimer = setTimeout(() => {
    expireAccessToken();
  }, delay);
}

function persistAuthSession(session: PersistedAuthSession): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(AUTH_KEY, JSON.stringify(session));
}

function clearPersistedAuthSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(AUTH_KEY);
}

function readPersistedAuthSession(): PersistedAuthSession | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(AUTH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedAuthSession>;
    if (!parsed.user || !parsed.accessToken) return null;
    if (parsed.sessionExpiresAt !== null && typeof parsed.sessionExpiresAt !== 'number') return null;
    if (typeof parsed.sessionExpiresAt === 'number' && parsed.sessionExpiresAt <= Date.now()) {
      clearPersistedAuthSession();
      return null;
    }
    return {
      user: parsed.user,
      accessToken: parsed.accessToken,
      sessionExpiresAt: parsed.sessionExpiresAt,
    };
  } catch {
    clearPersistedAuthSession();
    return null;
  }
}

function bootstrapSessionFromStorage(): SessionState {
  const persisted = readPersistedAuthSession();
  const refreshToken = readSecureRefreshToken();
  if (!persisted) {
    // No valid localStorage session; keep bootstrapping=true so AuthGuard
    // can attempt a silent /auth/refresh (browser cookie or native token).
    return { ...state, refreshToken };
  }
  const { locationId, registerId } = loadPerStorePrefs(persisted.user.storeId);
  if (persisted.sessionExpiresAt !== null) scheduleExpiry(persisted.sessionExpiresAt);
  return {
    user: persisted.user,
    accessToken: persisted.accessToken,
    refreshToken,
    locationId,
    registerId,
    sessionExpiresAt: persisted.sessionExpiresAt,
    bootstrapping: true,
  };
}

state = bootstrapSessionFromStorage();

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

export function oneHourFromNow(): number {
  return Date.now() + AUTH_TTL_MS;
}

export function setUser(user: SessionUser, accessToken: string, sessionExpiresAt: number | null = oneHourFromNow(), refreshToken?: string): void {
  const { locationId, registerId } = loadPerStorePrefs(user.storeId);
  const resolvedRefreshToken = refreshToken ?? state.refreshToken ?? null;
  state = { user, accessToken, refreshToken: resolvedRefreshToken, locationId, registerId, sessionExpiresAt, bootstrapping: false };
  persistAuthSession({ user, accessToken, sessionExpiresAt });
  if (refreshToken) storeSecureRefreshToken(refreshToken);
  if (sessionExpiresAt !== null) scheduleExpiry(sessionExpiresAt);
  emit();
}

export function setAccessToken(accessToken: string | null): void {
  state = { ...state, accessToken };
  emit();
}

export function clearSession(): void {
  clearExpiryTimer();
  clearPersistedAuthSession();
  clearSecureRefreshToken();
  state = {
    user: null,
    accessToken: null,
    refreshToken: null,
    locationId: null,
    registerId: null,
    sessionExpiresAt: null,
    bootstrapping: false,
  };
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
    state = { user, accessToken: null, refreshToken: null, locationId, registerId, sessionExpiresAt: null, bootstrapping: false };
    emit();
    return user;
  } catch {
    return null;
  }
}
