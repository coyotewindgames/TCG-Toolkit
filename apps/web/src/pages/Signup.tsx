import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signup, checkEmailAvailable } from '../lib/api';
import { setLocationId } from '../lib/session';

type Panel = 'store' | 'account';

function passwordStrength(pw: string): { label: string; color: string; width: string } {
  if (pw.length === 0) return { label: '', color: '', width: '0%' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: 'Weak', color: 'bg-rose-500', width: '33%' };
  if (score <= 3) return { label: 'Fair', color: 'bg-amber-400', width: '66%' };
  return { label: 'Strong', color: 'bg-emerald-500', width: '100%' };
}

export default function SignupPage() {
  const navigate = useNavigate();

  // Panel 1 — store
  const [storeName, setStoreName] = useState('');
  const [locationName, setLocationName] = useState('');

  // Panel 2 — account
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [emailAvailable, setEmailAvailable] = useState<boolean | null>(null);
  const [emailChecking, setEmailChecking] = useState(false);

  const [panel, setPanel] = useState<Panel>('store');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pwStrength = passwordStrength(ownerPassword);

  // Debounced email check on blur
  async function onEmailBlur() {
    const email = ownerEmail.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    setEmailChecking(true);
    try {
      const ok = await checkEmailAvailable(email);
      setEmailAvailable(ok);
    } finally {
      setEmailChecking(false);
    }
  }

  // Reset availability indicator when email changes
  useEffect(() => {
    setEmailAvailable(null);
  }, [ownerEmail]);

  function onStoreNext(e: FormEvent) {
    e.preventDefault();
    if (!storeName.trim()) return;
    setPanel('account');
  }

  async function onAccountSubmit(e: FormEvent) {
    e.preventDefault();
    if (emailAvailable === false) return; // block if taken
    setError(null);
    setSubmitting(true);
    try {
      const result = await signup({
        storeName,
        ownerName,
        ownerEmail,
        ownerPassword,
        locationName: locationName.trim() || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setLocationId(result.location.id);
      navigate('/onboarding', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    'w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500';
  const labelCls = 'block text-xs uppercase tracking-wide text-slate-400 mb-1';

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-md space-y-4">
        {/* Step indicator */}
        <div className="flex items-center gap-2 justify-center text-sm">
          <StepDot n={1} active={panel === 'store'} done={panel === 'account'} label="Your shop" />
          <div className="flex-1 h-px bg-slate-800" />
          <StepDot n={2} active={panel === 'account'} done={false} label="Your account" />
        </div>

        {panel === 'store' && (
          <form
            onSubmit={onStoreNext}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4"
          >
            <div>
              <h1 className="text-2xl font-bold">Create your shop</h1>
              <p className="text-sm text-slate-400">Tell us about your store first.</p>
            </div>

            <label className="block">
              <span className={labelCls}>Store name <span className="text-rose-400">*</span></span>
              <input
                autoFocus
                required
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                placeholder="e.g. Crystal Cave Cards"
                className={inputCls}
              />
            </label>

            <label className="block">
              <span className={labelCls}>
                Location name <span className="text-slate-500">(optional)</span>
              </span>
              <input
                value={locationName}
                onChange={(e) => setLocationName(e.target.value)}
                placeholder="Main (default)"
                className={inputCls}
              />
              <span className="text-xs text-slate-500">
                The name of your first physical location — you can add more later.
              </span>
            </label>

            <button
              type="submit"
              className="w-full bg-emerald-500 text-slate-900 font-semibold rounded-lg py-2"
            >
              Continue →
            </button>

            <p className="text-sm text-slate-400 text-center">
              Already have an account?{' '}
              <Link to="/login" className="text-emerald-400 hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        )}

        {panel === 'account' && (
          <form
            onSubmit={onAccountSubmit}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4"
          >
            <div>
              <button
                type="button"
                onClick={() => setPanel('store')}
                className="text-xs text-slate-400 hover:text-slate-200 mb-2 flex items-center gap-1"
              >
                ← Back
              </button>
              <h1 className="text-2xl font-bold">Your account</h1>
              <p className="text-sm text-slate-400">
                Creating the owner account for{' '}
                <span className="text-slate-200 font-medium">{storeName}</span>.
              </p>
            </div>

            <label className="block">
              <span className={labelCls}>Your name <span className="text-rose-400">*</span></span>
              <input
                autoFocus
                required
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                className={inputCls}
              />
            </label>

            <label className="block">
              <span className={labelCls}>Email <span className="text-rose-400">*</span></span>
              <input
                type="email"
                required
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                onBlur={onEmailBlur}
                className={`${inputCls} ${emailAvailable === false ? 'border-rose-500' : ''}`}
              />
              {emailChecking && (
                <span className="text-xs text-slate-400">Checking…</span>
              )}
              {!emailChecking && emailAvailable === false && (
                <span className="text-xs text-rose-400">
                  An account with this email already exists.{' '}
                  <Link to="/login" className="underline">Sign in?</Link>
                </span>
              )}
              {!emailChecking && emailAvailable === true && (
                <span className="text-xs text-emerald-400">✓ Available</span>
              )}
            </label>

            <label className="block">
              <span className={labelCls}>Password <span className="text-rose-400">*</span></span>
              <input
                type="password"
                required
                minLength={8}
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                className={inputCls}
              />
              {ownerPassword && (
                <div className="mt-1 space-y-0.5">
                  <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${pwStrength.color}`}
                      style={{ width: pwStrength.width }}
                    />
                  </div>
                  <span className={`text-xs ${pwStrength.color.replace('bg-', 'text-')}`}>
                    {pwStrength.label}
                  </span>
                </div>
              )}
              {!ownerPassword && (
                <span className="text-xs text-slate-500">At least 8 characters.</span>
              )}
            </label>

            {error && <p className="text-sm text-rose-400">{error}</p>}

            <button
              type="submit"
              disabled={submitting || emailAvailable === false || ownerPassword.length < 8}
              className="w-full bg-emerald-500 text-slate-900 font-semibold rounded-lg py-2 disabled:opacity-50"
            >
              {submitting ? 'Creating shop…' : 'Create shop'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function StepDot({
  n,
  active,
  done,
  label,
}: {
  n: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
          active
            ? 'bg-emerald-500 text-slate-900'
            : done
              ? 'bg-emerald-700 text-emerald-200'
              : 'bg-slate-800 text-slate-400'
        }`}
      >
        {done ? '✓' : n}
      </div>
      <span className={`text-xs ${active ? 'text-slate-200' : 'text-slate-500'}`}>{label}</span>
    </div>
  );
}
