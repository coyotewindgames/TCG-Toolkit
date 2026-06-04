import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface EnrichStatus {
  pending: number;
  running: boolean;
}

interface EnrichMatched {
  productId: string;
  name: string;
  setName: string | null;
  cardNumber: string | null;
  imageSourceUrl: string | null;
  tcgapiProductId: string;
}

interface EnrichBatchResult {
  scanned: number;
  matched: number;
  imagesUpdated: number;
  remaining: number;
  matches: EnrichMatched[];
  unmatched: Array<{ productId: string; name: string; reason: string }>;
}

interface TcgapiStatus {
  configured: boolean;
  hasKey: boolean;
}

/**
 * Backfill product images via tcgapi.dev. Lives in the Inventory side pane.
 * Shows a configuration prompt if tcgapi.dev isn't set up yet.
 */
export default function ImageBackfillPanel() {
  const qc = useQueryClient();

  const integrations = useQuery({
    queryKey: ['settings', 'integrations'],
    queryFn: () => api.get<{ tcgapi: TcgapiStatus }>('/settings/integrations'),
  });

  const status = useQuery({
    queryKey: ['inventory', 'enrich-status'],
    queryFn: () => api.get<EnrichStatus>('/inventory/enrich/status'),
    enabled: !!integrations.data?.tcgapi.configured && !!integrations.data?.tcgapi.hasKey,
  });

  const start = useMutation({
    mutationFn: () => api.post<EnrichBatchResult>('/inventory/enrich/backfill', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory', 'enrich-status'] });
      qc.invalidateQueries({ queryKey: ['products'] });
    },
  });

  if (integrations.isLoading) {
    return <p className="text-sm text-slate-400">Checking integration status…</p>;
  }

  const tcgapi = integrations.data?.tcgapi;
  if (!tcgapi?.configured || !tcgapi.hasKey) {
    return (
      <div className="text-sm space-y-2">
        <p className="text-amber-300">
          TCGapi.dev isn't configured yet. Add an API key under Settings → Integrations to
          enable image backfill.
        </p>
        <a
          href="/settings/integrations"
          className="btn inline-flex"
        >
          Open settings
        </a>
      </div>
    );
  }

  const pending = status.data?.pending ?? 0;
  const lastRun = start.data;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Fetches images from tcgapi.dev for products you imported earlier. Each click processes
        up to <strong>10 products</strong> — the free tier is capped at 100 requests per day.
      </p>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="text-sm">
          <span className="text-slate-400">Missing images:</span>{' '}
          <span className="text-slate-100 font-semibold">{pending.toLocaleString()}</span>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={pending === 0 || start.isPending}
          onClick={() => start.mutate()}
        >
          {pending === 0
            ? 'All caught up'
            : start.isPending
              ? 'Running…'
              : 'Backfill next 10'}
        </button>
      </div>

      {start.error && <p className="text-rose-300 text-sm">{String(start.error)}</p>}

      {lastRun && (
        <div className="space-y-3">
          <div className="text-xs text-slate-300">
            Scanned <strong>{lastRun.scanned}</strong> · Matched{' '}
            <strong>{lastRun.matched}</strong> · Updated{' '}
            <strong>{lastRun.imagesUpdated}</strong> · Remaining{' '}
            <strong>{lastRun.remaining}</strong>
          </div>

          {lastRun.matches.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 mb-2">Updated this batch:</div>
              <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {lastRun.matches.map((m) => (
                  <li
                    key={m.productId}
                    className="bg-slate-900/60 border border-slate-700 rounded-lg p-2 text-xs"
                  >
                    {m.imageSourceUrl ? (
                      <img
                        src={m.imageSourceUrl}
                        alt={m.name}
                        className="w-full aspect-[5/7] object-cover rounded mb-1 bg-slate-800"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full aspect-[5/7] rounded mb-1 bg-slate-800 border border-dashed border-slate-700" />
                    )}
                    <div className="font-semibold text-slate-100 truncate" title={m.name}>
                      {m.name}
                    </div>
                    <div className="text-slate-400 truncate">
                      {m.setName ?? '—'}
                      {m.cardNumber ? ` · #${m.cardNumber}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lastRun.unmatched.length > 0 && (
            <details>
              <summary className="cursor-pointer text-amber-300 text-sm">
                {lastRun.unmatched.length} unmatched
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-slate-300 max-h-48 overflow-auto">
                {lastRun.unmatched.map((u) => (
                  <li key={u.productId}>
                    {u.name} — <span className="opacity-70">{u.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
