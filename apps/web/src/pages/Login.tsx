import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login, loginWithGoogle } from '../lib/api';
import { firebaseEnabled } from '../lib/firebase';

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/locations/pick', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function onGoogleSignIn() {
    setError(null);
    setSubmitting(true);
    try {
      await loginWithGoogle();
      navigate('/locations/pick', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-navy text-ink p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-card border border-track rounded-2xl p-6 space-y-4"
      >
        <div>
          <h1 className="text-2xl font-bold">Sign in</h1>
          <p className="text-sm text-ink-muted">Welcome back to Turbocomp.</p>
        </div>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-ink-muted mb-1">Email</span>
          <input
            autoFocus
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-track border border-border rounded-lg px-3 py-2 outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-ink-muted mb-1">Password</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-track border border-border rounded-lg px-3 py-2 outline-none focus:border-brand"
          />
        </label>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-brand text-navy font-semibold rounded-lg py-2 disabled:opacity-50"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        {firebaseEnabled && (
          <>
            <div className="flex items-center gap-3 text-xs text-ink-dim">
              <span className="h-px flex-1 bg-track" />
              or
              <span className="h-px flex-1 bg-track" />
            </div>
            <button
              type="button"
              onClick={onGoogleSignIn}
              disabled={submitting}
              className="w-full border border-border bg-track text-ink font-semibold rounded-lg py-2 disabled:opacity-50 hover:border-brand"
            >
              Continue with Google
            </button>
          </>
        )}
        <div className="flex items-center justify-between text-sm">
          <Link to="/forgot-password" className="text-ink-muted hover:text-brand">
            Forgot password?
          </Link>
          <Link to="/signup" className="text-brand hover:underline">
            Create a shop
          </Link>
        </div>
      </form>
    </div>
  );
}
