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
  tcgapiProductId: string | null;
  source: 'pkmncards';
}

interface EnrichBatchResult {
  scanned: number;
  matched: number;
  imagesUpdated: number;
  remaining: number;
  matches: EnrichMatched[];
  unmatched: Array<{ productId: string; name: string; reason: string }>;
}

/**
 * Backfill product images from PkmnCards.
 */
export default function ImageBackfillPanel() {
  const qc = useQueryClient();

  const status = useQuery({
    queryKey: ['inventory', 'enrich-status'],
    queryFn: () => api.get<EnrichStatus>(`/inventory/enrich/status?ts=${Date.now()}`),
  });

  const start = useMutation({
    mutationFn: () => api.post<EnrichBatchResult>('/inventory/enrich/backfill', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory', 'enrich-status'] });
      qc.invalidateQueries({ queryKey: ['products'] });
    },
  });

  const pending = status.data?.pending ?? 0;
  const lastRun = start.data;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Fills missing product images for Pokemon inventory from PkmnCards. Each click
        processes up to <strong>50 products</strong>.
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
              : 'Backfill next 50'}
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
                      {' · PkmnCards'}
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

      {pending > 0 && (
        <p className="text-xs text-slate-400">
          {pending.toLocaleString()} products still need images.
        </p>
      )}
    </div>
  );
}
