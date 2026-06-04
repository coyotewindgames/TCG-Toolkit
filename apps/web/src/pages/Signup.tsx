import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signup } from '../lib/api';
import { setLocationId } from '../lib/session';

export default function SignupPage() {
  const navigate = useNavigate();
  const [storeName, setStoreName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signup({
        storeName,
        ownerName,
        ownerEmail,
        ownerPassword,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      // The default location is created server-side; pre-select it so the
      // user lands straight on the dashboard instead of a one-option picker.
      setLocationId(result.location.id);
      navigate('/onboarding', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4"
      >
        <div>
          <h1 className="text-2xl font-bold">Create your shop</h1>
          <p className="text-sm text-slate-400">Get your store running in under a minute.</p>
        </div>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">Store name</span>
          <input
            autoFocus
            required
            value={storeName}
            onChange={(e) => setStoreName(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">Your name</span>
          <input
            required
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">Email</span>
          <input
            type="email"
            required
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">Password</span>
          <input
            type="password"
            required
            minLength={8}
            value={ownerPassword}
            onChange={(e) => setOwnerPassword(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
          />
          <span className="text-xs text-slate-500">At least 8 characters.</span>
        </label>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-emerald-500 text-slate-900 font-semibold rounded-lg py-2 disabled:opacity-50"
        >
          {submitting ? 'Creating shop…' : 'Create shop'}
        </button>
        <p className="text-sm text-slate-400 text-center">
          Already have an account?{' '}
          <Link to="/login" className="text-emerald-400 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
