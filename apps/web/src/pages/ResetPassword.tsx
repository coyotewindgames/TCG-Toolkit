import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { confirmPasswordReset } from '../lib/api';
import { clearSession } from '../lib/session';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await confirmPasswordReset(token, password);
      // Server already revoked any active session for the user. Wipe local
      // state too so a stale token in memory can't be reused on this device.
      clearSession();
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
        <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3 text-center">
          <h1 className="text-xl font-bold">Invalid reset link</h1>
          <p className="text-sm text-slate-400">
            This page needs a token from the email we sent. Request a new link to continue.
          </p>
          <Link
            to="/forgot-password"
            className="block bg-emerald-500 text-slate-900 font-semibold rounded-lg py-2"
          >
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Choose a new password</h1>
          <p className="text-sm text-slate-400">At least 8 characters.</p>
        </div>

        {done ? (
          <p className="text-sm text-emerald-400">
            Password updated. Sending you to sign in…
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
                New password
              </span>
              <input
                autoFocus
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
                Confirm password
              </span>
              <input
                type="password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
              />
            </label>
            {error && <p className="text-sm text-rose-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-emerald-500 text-slate-900 font-semibold rounded-lg py-2 disabled:opacity-50"
            >
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
