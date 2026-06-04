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
import InventoryPage from './pages/Inventory';
import TradeInPage from './pages/TradeIn';
import SettingsIntegrationsPage from './pages/SettingsIntegrations';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

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
            <Route path="/" element={<Navigate to="/register" replace />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/tradein" element={<TradeInPage />} />
            <Route path="/settings/integrations" element={<SettingsIntegrationsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
