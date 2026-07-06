import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import { AuthGuard, RequireLocation } from './components/AuthGuard';
import LoginPage from './pages/Login';
import SignupPage from './pages/Signup';
import WelcomePage from './pages/Welcome';
import ForgotPasswordPage from './pages/ForgotPassword';
import ResetPasswordPage from './pages/ResetPassword';
import OnboardingPage from './pages/Onboarding';
import PickLocationPage from './pages/PickLocation';
import RegisterPage from './pages/Register';
import RemoteScanPage from './pages/RemoteScan';
import InventoryPage from './pages/Inventory';
import TradeInPage from './pages/TradeIn';
import TransactionsPage from './pages/Transactions';
import AnalyticsPage from './pages/Analytics';
import SettingsIntegrationsPage from './pages/SettingsIntegrations';
import { useQuery } from '@tanstack/react-query';
import { useSession } from './hooks/useSession';
import { getOnboardingStatus } from './lib/api';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

/** Redirect `/` — owners without completed onboarding go to `/onboarding`, others to `/register`. */
function RootRedirect() {
  const session = useSession();
  const isOwner = session.user?.role === 'owner';
  const { data, isLoading } = useQuery({
    queryKey: ['onboarding-status'],
    queryFn: getOnboardingStatus,
    enabled: isOwner,
    staleTime: 60_000,
  });

  if (isOwner && isLoading) return null; // brief loading pause — avoid flash

  if (isOwner && data?.completedAt == null) {
    return <Navigate to="/onboarding" replace />;
  }
  return <Navigate to="/transactions" replace />;
}

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public auth routes */}
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />

          {/* Authenticated routes that don't require a chosen location yet */}
          <Route
            path="/locations/pick"
            element={
              <AuthGuard>
                <PickLocationPage />
              </AuthGuard>
            }
          />
          <Route
            path="/onboarding"
            element={
              <AuthGuard>
                <OnboardingPage />
              </AuthGuard>
            }
          />
          <Route
            path="/remote-scan"
            element={
              <AuthGuard>
                <RemoteScanPage />
              </AuthGuard>
            }
          />

          {/* Authenticated + location-selected routes */}
          <Route
            element={
              <AuthGuard>
                <RequireLocation>
                  <AppLayout />
                </RequireLocation>
              </AuthGuard>
            }
          >
            <Route path="/" element={<RootRedirect />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/tradein" element={<TradeInPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/settings/integrations" element={<SettingsIntegrationsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
