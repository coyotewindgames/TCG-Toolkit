import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login } from '../lib/api';

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

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4"
      >
        <div>
          <h1 className="text-2xl font-bold">Sign in</h1>
          <p className="text-sm text-slate-400">Welcome back to TCG Toolkit.</p>
        </div>
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
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">Password</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
          />
        </label>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-emerald-500 text-slate-900 font-semibold rounded-lg py-2 disabled:opacity-50"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="flex items-center justify-between text-sm">
          <Link to="/forgot-password" className="text-slate-400 hover:text-emerald-400">
            Forgot password?
          </Link>
          <Link to="/signup" className="text-emerald-400 hover:underline">
            Create a shop
          </Link>
        </div>
      </form>
    </div>
  );
}
