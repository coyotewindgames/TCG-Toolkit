import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../lib/api';

interface EnrichStatus {
  pending: number;
  running: boolean;
}

interface TcgapiStatus {
  configured: boolean;
  hasKey: boolean;
}

interface StartBackfillResponse {
  started: boolean;
  running: boolean;
  pending: number;
}

/**
 * Backfill product images via tcgapi.dev. Lives in the Inventory side pane.
 * Shows a configuration prompt if tcgapi.dev isn't set up yet.
 */
export default function ImageBackfillPanel() {
  const qc = useQueryClient();
  const wasRunningRef = useRef(false);

  const integrations = useQuery({
    queryKey: ['settings', 'integrations'],
    queryFn: () => api.get<{ tcgapi: TcgapiStatus }>('/settings/integrations'),
  });

  const status = useQuery({
    queryKey: ['inventory', 'enrich-status'],
    queryFn: () => api.get<EnrichStatus>('/inventory/enrich/status'),
    enabled: !!integrations.data?.tcgapi.configured && !!integrations.data?.tcgapi.hasKey,
    refetchInterval: (query) => {
      const data = query.state.data as EnrichStatus | undefined;
      return data?.running ? 2000 : false;
    },
    refetchIntervalInBackground: true,
  });

  const start = useMutation({
    mutationFn: () => api.post<StartBackfillResponse>('/inventory/enrich/backfill', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory', 'enrich-status'] });
    },
  });

  useEffect(() => {
    const running = !!status.data?.running;
    if (running) {
      wasRunningRef.current = true;
      return;
    }

    if (wasRunningRef.current) {
      wasRunningRef.current = false;
      qc.invalidateQueries({ queryKey: ['products'] });
    }
  }, [qc, status.data?.running]);

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
  const running = !!status.data?.running;
  const startResult = start.data;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Fetches images from tcgapi.dev for products you imported earlier. One click starts a
        background job that keeps running on the server even if you navigate away.
      </p>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="text-sm">
          <span className="text-slate-400">Missing images:</span>{' '}
          <span className="text-slate-100 font-semibold">{pending.toLocaleString()}</span>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={pending === 0 || start.isPending || running}
          onClick={() => start.mutate()}
        >
          {pending === 0
            ? 'All caught up'
            : running
              ? 'Running in background…'
              : start.isPending
                ? 'Starting…'
                : 'Backfill all images'}
        </button>
      </div>

      {running && (
        <div className="text-xs text-slate-300">
          Background job is running. Remaining <strong>{pending.toLocaleString()}</strong> products.
        </div>
      )}

      {!running && startResult?.started && (
        <div className="text-xs text-emerald-300">Background backfill started successfully.</div>
      )}

      {!running && startResult && !startResult.started && startResult.pending > 0 && (
        <div className="text-xs text-slate-300">A backfill run is already in progress.</div>
      )}

      {start.error && <p className="text-rose-300 text-sm">{String(start.error)}</p>}

      {!running && pending > 0 && (
        <p className="text-xs text-slate-400">
          {pending.toLocaleString()} products still need images. Start backfill to resume.
        </p>
      )}
    </div>
  );
}
