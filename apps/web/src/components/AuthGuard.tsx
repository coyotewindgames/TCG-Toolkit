import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { refreshAccessToken } from '../lib/api';
import {
  setBootstrapping,
  setLocationId,
  setRegisterId,
  setUser,
  type SessionUser,
  tryDevUserBootstrap,
} from '../lib/session';

type RemoteScanHandoff = {
  accessToken: string;
  user: SessionUser;
  locationId?: string | null;
  registerId?: string | null;
};

function fromBase64UrlJson<T>(raw: string): T | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4 || 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Wraps protected routes. On first mount we attempt a silent token refresh;
 * if that fails we fall back to the dev escape-hatch (VITE_DEV_USER) only in
 * development. Anything else redirects to /login.
 *
 * The location.pathname is preserved as `from` state so we can bounce back
 * after a successful login.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();

  useEffect(() => {
    if (session.user) return;
    if (location.pathname !== '/remote-scan') return;
    const hash = location.hash?.startsWith('#') ? location.hash.slice(1) : location.hash;
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const handoff = params.get('h');
    if (!handoff) return;

    const decoded = fromBase64UrlJson<RemoteScanHandoff>(handoff);
    if (!decoded?.accessToken || !decoded?.user?.id || !decoded?.user?.storeId) return;

    setUser(decoded.user, decoded.accessToken);
    setLocationId(decoded.locationId ?? null);
    setRegisterId(decoded.registerId ?? null);

    if (typeof window !== 'undefined') {
      const clean = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', clean);
    }
  }, [location.hash, location.pathname, session.user]);

  useEffect(() => {
    // Only attempt bootstrap once, on the very first mount.
    if (!session.bootstrapping) return;
    let cancelled = false;
    void (async () => {
      try {
        const token = await refreshAccessToken();
        if (cancelled) return;
        if (!token) {
          // No real session — try dev fallback if configured.
          tryDevUserBootstrap();
        }
      } catch {
        // Network/CORS error during refresh — treat as logged out so the UI
        // can route to /welcome instead of hanging on the loading screen.
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.bootstrapping]);

  if (session.bootstrapping) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400">
        Loading…
      </div>
    );
  }
  if (!session.user) {
    return <Navigate to="/welcome" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

/**
 * Used on the AppLayout-protected routes that need a chosen location. Sends
 * users to the picker if none is selected. The picker itself is *not*
 * wrapped in this guard (it would loop) — only AuthGuard covers it.
 */
export function RequireLocation({ children }: { children: ReactNode }) {
  const session = useSession();
  if (!session.locationId) {
    return <Navigate to="/locations/pick" replace />;
  }
  return <>{children}</>;
}
