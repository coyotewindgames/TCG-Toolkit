import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

type PkmnpricesTier = 'free' | 'pro' | 'business';

interface PkmnpricesStatus {
  configured: boolean;
  baseUrl: string;
  hasKey: boolean;
  tier: PkmnpricesTier;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
}

interface PosStatus {
  configured: boolean;
  provider: 'clover';
  baseUrl: string;
  merchantId: string | null;
  hasToken: boolean;
  hasWebhookSecret: boolean;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
}

interface IntegrationsResponse {
  pkmnprices: PkmnpricesStatus;
  pos: PosStatus;
}

export default function SettingsIntegrationsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings', 'integrations'],
    queryFn: () => api.get<IntegrationsResponse>('/settings/integrations'),
  });

  if (isLoading) return <p className="p-6 text-ink-muted">Loading…</p>;
  if (error) {
    return (
      <p className="p-6 text-rose-400">
        Failed to load integrations. You may need owner permissions: {String(error)}
      </p>
    );
  }
  if (!data) return null;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-sm text-ink-muted mt-1">
          Credentials are encrypted at rest with AES-256-GCM and never displayed back to the
          browser. Existing secrets are kept when you save without re-entering them.
        </p>
      </header>

      <PkmnpricesCard
        status={data.pkmnprices}
        onSaved={() => qc.invalidateQueries({ queryKey: ['settings', 'integrations'] })}
      />
      <PosCard
        status={data.pos}
        onSaved={() => qc.invalidateQueries({ queryKey: ['settings', 'integrations'] })}
      />
    </div>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${
        ok ? 'bg-brand/20 text-brand' : 'bg-rose-500/20 text-rose-300'
      }`}
    >
      {label}
    </span>
  );
}

function PkmnpricesCard({ status, onSaved }: { status: PkmnpricesStatus; onSaved: () => void }) {
  const [baseUrl, setBaseUrl] = useState(status.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [tier, setTier] = useState<PkmnpricesTier>(status.tier);
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    setBaseUrl(status.baseUrl);
    setTier(status.tier);
  }, [status.baseUrl, status.tier]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put('/settings/integrations/pkmnprices', body),
    onSuccess: () => {
      setMsg({ kind: 'ok', text: 'Saved.' });
      setApiKey('');
      setPassword('');
      onSaved();
    },
    onError: (e: unknown) => setMsg({ kind: 'err', text: String(e) }),
  });

  const verify = useMutation({
    mutationFn: () => api.post('/settings/integrations/pkmnprices/verify', {}),
    onSuccess: () => {
      setMsg({ kind: 'ok', text: 'Connection verified.' });
      onSaved();
    },
    onError: (e: unknown) => setMsg({ kind: 'err', text: String(e) }),
  });

  return (
    <section className="bg-track/50 border border-border rounded-xl p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">PkmnPrices.com</h2>
          <p className="text-xs text-ink-muted mt-1">
            Primary price source for Pokémon. Pro tier is required for Japanese-language prices and
            EUR/Cardmarket data.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <StatusBadge ok={status.configured} label={status.configured ? 'configured' : 'not set'} />
          {status.configured && (
            <StatusBadge ok={status.hasKey} label={status.hasKey ? 'key on file' : 'no key'} />
          )}
          <span className="text-xs text-ink-muted">tier: {status.tier}</span>
          {status.lastVerifiedAt && (
            <span className="text-xs text-ink-muted">
              verified {new Date(status.lastVerifiedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(null);
          const trimmedApiKey = apiKey.trim();
          if (!status.hasKey && !trimmedApiKey) {
            setMsg({ kind: 'err', text: 'API key is required when configuring PkmnPrices for the first time.' });
            return;
          }
          const body: Record<string, unknown> = {
            baseUrl: baseUrl.trim(),
            tier,
            password: import.meta.env.DEV ? 'dev-bypass' : password,
          };
          if (trimmedApiKey) body.apiKey = trimmedApiKey;
          save.mutate(body);
        }}
      >
        <Field label="Base URL">
          <input
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
          />
        </Field>
        <Field label={status.hasKey ? 'API key (leave blank to keep current)' : 'API key'}>
          <input
            className="input"
            type="password"
            value={apiKey}
            placeholder={status.hasKey ? '•••••••••••• (unchanged)' : 'pkmnprices_…'}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="Tier">
          <select
            className="input"
            value={tier}
            onChange={(e) => setTier(e.target.value as PkmnpricesTier)}
          >
            <option value="free">Free — English only, USD, 1K credits/day</option>
            <option value="pro">Pro — + Japanese, EUR, 20K credits/day</option>
            <option value="business">Business — 100K credits/day</option>
          </select>
        </Field>
        {!import.meta.env.DEV && (
          <Field label="Confirm your password">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>
        )}
        <div className="flex gap-2 pt-1">
          <button type="submit" className="btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setMsg(null);
              verify.mutate();
            }}
            disabled={!status.configured || verify.isPending}
          >
            {verify.isPending ? 'Verifying…' : 'Verify connection'}
          </button>
        </div>
        <Message msg={msg} />
      </form>
    </section>
  );
}

function PosCard({ status, onSaved }: { status: PosStatus; onSaved: () => void }) {
  const [baseUrl, setBaseUrl] = useState(status.baseUrl);
  const [merchantId, setMerchantId] = useState(status.merchantId ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [webhookSigningSecret, setWebhookSigningSecret] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put('/settings/integrations/pos', body),
    onSuccess: () => {
      setMsg({ kind: 'ok', text: 'Saved.' });
      setAccessToken('');
      setWebhookSigningSecret('');
      setPassword('');
      onSaved();
    },
    onError: (e: unknown) => setMsg({ kind: 'err', text: String(e) }),
  });

  const verify = useMutation({
    mutationFn: () => api.post('/settings/integrations/pos/verify', {}),
    onSuccess: () => {
      setMsg({ kind: 'ok', text: 'Clover credentials verified.' });
      onSaved();
    },
    onError: (e: unknown) => setMsg({ kind: 'err', text: String(e) }),
  });

  return (
    <section className="bg-track/50 border border-border rounded-xl p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Clover (POS)</h2>
        <div className="flex gap-2">
          <StatusBadge ok={status.configured} label={status.configured ? 'configured' : 'not set'} />
          {status.configured && (
            <>
              <StatusBadge ok={status.hasToken} label={status.hasToken ? 'token' : 'no token'} />
              <StatusBadge
                ok={status.hasWebhookSecret}
                label={status.hasWebhookSecret ? 'webhook' : 'no webhook'}
              />
            </>
          )}
          {status.lastVerifiedAt && (
            <span className="text-xs text-ink-muted">
              verified {new Date(status.lastVerifiedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(null);
          const body: Record<string, unknown> = {
            baseUrl,
            merchantId,
            password: import.meta.env.DEV ? 'dev-bypass' : password,
          };
          if (accessToken) body.accessToken = accessToken;
          if (webhookSigningSecret) body.webhookSigningSecret = webhookSigningSecret;
          save.mutate(body);
        }}
      >
        <Field label="Base URL">
          <input
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
          />
        </Field>
        <Field label="Merchant ID">
          <input
            className="input"
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
            required
          />
        </Field>
        <Field label={status.hasToken ? 'Access token (leave blank to keep current)' : 'Access token'}>
          <input
            className="input"
            type="password"
            value={accessToken}
            placeholder={status.hasToken ? '•••••••••••• (unchanged)' : ''}
            onChange={(e) => setAccessToken(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field
          label={
            status.hasWebhookSecret
              ? 'Webhook signing secret (leave blank to keep current)'
              : 'Webhook signing secret'
          }
        >
          <input
            className="input"
            type="password"
            value={webhookSigningSecret}
            placeholder={status.hasWebhookSecret ? '•••••••••••• (unchanged)' : ''}
            onChange={(e) => setWebhookSigningSecret(e.target.value)}
            autoComplete="off"
          />
        </Field>
        {!import.meta.env.DEV && (
          <Field label="Confirm your password">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>
        )}
        <div className="flex gap-2 pt-1">
          <button type="submit" className="btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setMsg(null);
              verify.mutate();
            }}
            disabled={!status.configured || verify.isPending}
          >
            {verify.isPending ? 'Verifying…' : 'Verify connection'}
          </button>
        </div>
        <Message msg={msg} />
      </form>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-ink-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Message({ msg }: { msg: { kind: 'ok' | 'err'; text: string } | null }) {
  if (!msg) return null;
  return (
    <p
      className={`text-sm ${
        msg.kind === 'ok' ? 'text-brand' : 'text-rose-300'
      }`}
    >
      {msg.text}
    </p>
  );
}
