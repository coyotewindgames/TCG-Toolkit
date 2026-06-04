import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset } from '../lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      // Server returns 204 regardless of whether the email exists, so we
      // always show the same confirmation — that's intentional, see
      // password-reset-service.ts.
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Forgot password</h1>
          <p className="text-sm text-slate-400">
            Enter your email and we'll send you a link to set a new one.
          </p>
        </div>

        {submitted ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-200">
              If <span className="text-emerald-400">{email}</span> matches an account, a reset
              link is on its way. The link expires in 1 hour.
            </p>
            <p className="text-xs text-slate-500">
              Didn't get it? Check your spam folder, or wait a few minutes and try again.
            </p>
            <Link to="/login" className="block text-sm text-emerald-400 hover:underline">
              ← Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">Email</span>
              <input
                autoFocus
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
              />
            </label>
            {error && <p className="text-sm text-rose-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-emerald-500 text-slate-900 font-semibold rounded-lg py-2 disabled:opacity-50"
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
            <p className="text-sm text-slate-400 text-center">
              <Link to="/login" className="text-emerald-400 hover:underline">
                Back to sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
