import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { refreshAccessToken } from '../lib/api';
import { setBootstrapping, tryDevUserBootstrap } from '../lib/session';

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
    // Only attempt bootstrap once, on the very first mount.
    if (!session.bootstrapping) return;
    let cancelled = false;
    void (async () => {
      const token = await refreshAccessToken();
      if (cancelled) return;
      if (!token) {
        // No real session — try dev fallback if configured.
        tryDevUserBootstrap();
      }
      setBootstrapping(false);
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
