import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../hooks/useSession';
import { api, completeOnboarding } from '../lib/api';
import CsvImporterPanel from '../components/CsvImporterPanel';

type Step = 1 | 2 | 3 | 4 | 5;

interface LocationRow {
  id: string;
  name: string;
  address?: Record<string, string> | null;
}

interface TcgapiStatus {
  configured: boolean;
  hasKey: boolean;
}

interface IntegrationsResponse {
  tcgapi: TcgapiStatus;
}

// ---- Root wizard ----------------------------------------------------------

export default function OnboardingPage() {
  const session = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [tcgapiDone, setTcgapiDone] = useState(false);
  const [inventoryDone, setInventoryDone] = useState(false);

  const name = session.user?.displayName ?? 'there';

  async function finish() {
    await completeOnboarding();
    qc.invalidateQueries({ queryKey: ['onboarding-status'] });
    setStep(5);
  }

  const steps: { n: Step; label: string }[] = [
    { n: 1, label: 'Shop' },
    { n: 2, label: 'TCGapi' },
    { n: 3, label: 'Inventory' },
    { n: 4, label: 'Clover' },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">Welcome, {name} 👋</h1>
          <p className="text-slate-400 text-sm">
            Let's get your shop running. You can skip any step and come back later.
          </p>
        </header>

        {/* Progress bar */}
        {step < 5 && (
          <nav className="flex items-center gap-1">
            {steps.map((s, i) => (
              <div key={s.n} className="flex items-center gap-1 flex-1">
                <button
                  type="button"
                  onClick={() => step > s.n && setStep(s.n)}
                  className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-lg transition-colors ${
                    step === s.n
                      ? 'bg-emerald-500 text-slate-900'
                      : step > s.n
                        ? 'text-emerald-400 hover:text-emerald-300'
                        : 'text-slate-500 cursor-default'
                  }`}
                >
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                    step > s.n ? 'bg-emerald-700 text-emerald-200' : step === s.n ? 'bg-slate-900 text-emerald-400' : 'bg-slate-800 text-slate-500'
                  }`}>
                    {step > s.n ? '✓' : s.n}
                  </span>
                  {s.label}
                </button>
                {i < steps.length - 1 && (
                  <div className={`flex-1 h-px ${step > s.n ? 'bg-emerald-700' : 'bg-slate-800'}`} />
                )}
              </div>
            ))}
          </nav>
        )}

        {/* Step panels */}
        {step === 1 && (
          <StepShopBasics onNext={() => setStep(2)} />
        )}
        {step === 2 && (
          <StepTcgapi
            onNext={() => { setTcgapiDone(true); setStep(3); }}
            onSkip={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <StepInventory
            onNext={() => { setInventoryDone(true); setStep(4); }}
            onSkip={() => setStep(4)}
          />
        )}
        {step === 4 && (
          <StepClover onFinish={finish} />
        )}
        {step === 5 && (
          <StepDone
            tcgapiDone={tcgapiDone}
            inventoryDone={inventoryDone}
            navigate={navigate}
          />
        )}
      </div>
    </div>
  );
}

// ---- Step 1: Shop basics --------------------------------------------------

function StepShopBasics({ onNext }: { onNext: () => void }) {
  const session = useSession();
  const [locationName, setLocationName] = useState('');
  const [address, setAddress] = useState({ street: '', city: '', state: '', zip: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const locationsQuery = useQuery({
    queryKey: ['locations'],
    queryFn: () => api.get<{ locations: LocationRow[] }>('/locations'),
  });

  const primaryLocation = locationsQuery.data?.locations[0];

  // Populate form with existing location name once loaded
  useEffect(() => {
    if (primaryLocation?.name && primaryLocation.name !== 'Main') {
      setLocationName(primaryLocation.name);
    }
  }, [primaryLocation]);

  async function save() {
    if (!primaryLocation) { onNext(); return; }
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (locationName.trim() && locationName.trim() !== primaryLocation.name) {
        body.name = locationName.trim();
      }
      const hasAddress = Object.values(address).some((v) => v.trim());
      if (hasAddress) body.address = address;
      if (Object.keys(body).length > 0) {
        await api.patch(`/locations/${primaryLocation.id}`, body);
      }
      setSaved(true);
      onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Step 1 — Your shop" subtitle="Confirm your store details.">
      {locationsQuery.isLoading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-1">
            <p className="text-xs text-slate-400 uppercase tracking-wide">Store</p>
            <p className="font-semibold">{session.user?.displayName ? `${session.user.displayName}'s shop` : '—'}</p>
          </div>

          <label className="block text-sm">
            <span className="text-slate-300 block mb-1">Location name</span>
            <input
              className="input w-full"
              value={locationName}
              placeholder={primaryLocation?.name ?? 'Main'}
              onChange={(e) => setLocationName(e.target.value)}
            />
          </label>

          <div>
            <p className="text-sm text-slate-300 mb-2">Address <span className="text-slate-500">(optional)</span></p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(['street', 'city', 'state', 'zip'] as const).map((f) => (
                <label key={f} className="block text-sm capitalize">
                  <span className="text-slate-400 block mb-0.5">{f}</span>
                  <input
                    className="input w-full"
                    value={address[f]}
                    onChange={(e) => setAddress((a) => ({ ...a, [f]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
          </div>

          {err && <p className="text-rose-300 text-sm">{err}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Looks good →'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---- Step 2: TCGapi.dev ---------------------------------------------------

function StepTcgapi({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [baseUrl, setBaseUrl] = useState('https://api.tcgapi.dev/v1');
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const qc = useQueryClient();

  const status = useQuery({
    queryKey: ['tcgapi-status'],
    queryFn: () => api.get<IntegrationsResponse>('/settings/integrations').then((d) => d.tcgapi),
  });

  const save = useMutation({
    mutationFn: () =>
      api.put('/settings/integrations/tcgapi/onboarding', { baseUrl, apiKey: apiKey || undefined }),
    onSuccess: () => {
      setMsg({ kind: 'ok', text: 'Saved! Verifying…' });
      verify.mutate();
    },
    onError: (e: unknown) => setMsg({ kind: 'err', text: String(e) }),
  });

  const verify = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>('/settings/integrations/tcgapi/verify', {}),
    onSuccess: (data) => {
      if (data.ok) {
        setMsg({ kind: 'ok', text: '✓ Connected! Moving on…' });
        qc.invalidateQueries({ queryKey: ['tcgapi-status'] });
        setTimeout(onNext, 800);
      } else {
        setMsg({ kind: 'err', text: data.error ?? 'Verification failed' });
      }
    },
    onError: (e: unknown) => setMsg({ kind: 'err', text: String(e) }),
  });

  const alreadyConfigured = status.data?.configured && status.data?.hasKey;

  return (
    <Card
      title="Step 2 — Connect TCGapi.dev"
      subtitle="Powers product images and market pricing for your catalog."
      badge={alreadyConfigured ? { text: 'already connected', ok: true } : undefined}
    >
      {alreadyConfigured ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-300">
            TCGapi.dev is already configured for your store. You can update it later in Settings.
          </p>
          <div className="flex gap-3">
            <button type="button" className="btn-primary" onClick={onNext}>Continue →</button>
            <button type="button" className="btn" onClick={onSkip}>Skip</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-400">
            Sign up at{' '}
            <a href="https://tcgapi.dev" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">
              tcgapi.dev
            </a>{' '}
            to get an API key. The free tier is plenty to get started.
          </p>

          <label className="block text-sm">
            <span className="text-slate-300 block mb-1">API key</span>
            <input
              className="input w-full"
              type="password"
              autoComplete="off"
              placeholder="tcg_live_…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>

          <label className="block text-sm">
            <span className="text-slate-300 block mb-1">Base URL</span>
            <input
              className="input w-full"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>

          {msg && (
            <p className={`text-sm ${msg.kind === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>
              {msg.text}
            </p>
          )}

          <div className="flex gap-3 flex-wrap">
            <button
              type="button"
              className="btn-primary"
              onClick={() => { setMsg(null); save.mutate(); }}
              disabled={!apiKey || save.isPending || verify.isPending}
            >
              {save.isPending || verify.isPending ? 'Connecting…' : 'Connect & verify'}
            </button>
            <button type="button" className="btn" onClick={onSkip}>
              Skip for now
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---- Step 3: Import inventory ---------------------------------------------

function StepInventory({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <Card
      title="Step 3 — Import inventory"
      subtitle="Got a CSV from Collectr, TCGplayer, or Deckbox? Import it now."
    >
      <div className="space-y-4">
        <CsvImporterPanel hideDryRun onImportSuccess={() => setTimeout(onNext, 600)} />
        <div className="pt-1">
          <button type="button" className="text-sm text-slate-400 hover:text-slate-200" onClick={onSkip}>
            Skip — I'll add inventory manually →
          </button>
        </div>
      </div>
    </Card>
  );
}

// ---- Step 4: Clover POS (optional) ----------------------------------------

function StepClover({ onFinish }: { onFinish: () => void }) {
  return (
    <Card
      title="Step 4 — Clover POS"
      subtitle="Optional — only needed if you take card payments through Toolkit."
      optionalBadge
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-300">
          Clover lets customers pay by card directly from the Register page. You'll need:
        </p>
        <ul className="list-disc list-inside text-sm text-slate-400 space-y-1">
          <li>Your Clover merchant ID</li>
          <li>An access token from your Clover developer dashboard</li>
          <li>A webhook signing secret</li>
        </ul>
        <p className="text-sm text-slate-400">
          You can set this up any time from{' '}
          <Link to="/settings/integrations" className="text-emerald-400 hover:underline">
            Settings → Integrations
          </Link>
          .
        </p>
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-primary" onClick={onFinish}>
            Finish setup →
          </button>
          <Link to="/settings/integrations" className="btn">
            Set up Clover now
          </Link>
        </div>
      </div>
    </Card>
  );
}

// ---- Step 5: Done ----------------------------------------------------------

function StepDone({
  tcgapiDone,
  inventoryDone,
  navigate,
}: {
  tcgapiDone: boolean;
  inventoryDone: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <div className="space-y-6">
      <div className="text-center py-6">
        <div className="text-5xl mb-3">🎉</div>
        <h2 className="text-2xl font-bold">Your shop is ready!</h2>
        <p className="text-slate-400 mt-1 text-sm">Here's a summary of what's set up.</p>
      </div>

      <ul className="space-y-2">
        <SummaryRow icon="✓" text="Shop created" done />
        <SummaryRow icon={tcgapiDone ? '✓' : '○'} text="TCGapi.dev connected" done={tcgapiDone} />
        <SummaryRow icon={inventoryDone ? '✓' : '○'} text="Inventory imported" done={inventoryDone} />
      </ul>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
        <button
          type="button"
          className="btn-primary py-3 text-center"
          onClick={() => navigate('/inventory', { replace: true })}
        >
          Go to Inventory →
        </button>
        <button
          type="button"
          className="btn py-3 text-center"
          onClick={() => navigate('/register', { replace: true })}
        >
          Open Register →
        </button>
      </div>

      {(!tcgapiDone || !inventoryDone) && (
        <p className="text-xs text-slate-500 text-center">
          You can finish the remaining steps any time from{' '}
          <Link to="/settings/integrations" className="text-emerald-400 hover:underline">
            Settings
          </Link>
          .
        </p>
      )}
    </div>
  );
}

// ---- Shared sub-components ------------------------------------------------

interface CardProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  badge?: { text: string; ok: boolean };
  optionalBadge?: boolean;
}

function Card({ title, subtitle, children, badge, optionalBadge }: CardProps) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-xl font-bold">{title}</h2>
          {badge && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${badge.ok ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
              {badge.text}
            </span>
          )}
          {optionalBadge && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">
              optional
            </span>
          )}
        </div>
        <p className="text-sm text-slate-400 mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function SummaryRow({ icon, text, done }: { icon: string; text: string; done: boolean }) {
  return (
    <li className={`flex items-center gap-3 text-sm px-4 py-2 rounded-lg ${done ? 'text-slate-200' : 'text-slate-500'}`}>
      <span className={`font-bold ${done ? 'text-emerald-400' : 'text-slate-600'}`}>{icon}</span>
      {text}
    </li>
  );
}
