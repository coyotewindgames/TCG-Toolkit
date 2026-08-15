import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TradeListItem, TradeListResponse } from '@tcg/shared';
import { PAYOUT_KINDS, TRADE_STATUSES } from '@tcg/shared';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import { formatCentsAsCurrency } from '../lib/format';
import { openOrDownloadBlob } from '../lib/downloadBlob';

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  completed: 'Completed',
};

const PAYOUT_LABELS: Record<string, string> = {
  cash: 'Buy (cash)',
  store_credit: 'Trade (store credit)',
};

const STATUS_BADGE_CLASSES: Record<string, string> = {
  completed: 'border-brand-dark/60 bg-brand/40 text-brand',
  pending_approval: 'border-amber-800/60 bg-amber-950/40 text-amber-200',
  approved: 'border-sky-800/60 bg-sky-950/40 text-sky-200',
  rejected: 'border-rose-800/60 bg-rose-950/40 text-rose-200',
  draft: 'border-border bg-track/60 text-ink-muted',
};

function ViewBillOfSaleButton({ trade }: { trade: TradeListItem }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const blob = await api.getBlob(`/tradeins/${trade.id}/bill-of-sale.pdf`);
      openOrDownloadBlob(blob, `bill-of-sale-${trade.id.slice(0, 8)}.pdf`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Bills of sale are only generated for finalized trades — draft/pending/rejected
  // trades never reached the `completed` DB status the PDF endpoint requires.
  if (trade.status !== 'completed') {
    return <span className="text-xs text-ink-dim">—</span>;
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={loading}
        className="min-h-8 rounded-lg border border-border bg-card px-3 py-1 text-xs font-semibold text-ink transition hover:bg-track disabled:opacity-50"
      >
        {loading ? 'Opening…' : 'View'}
      </button>
      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}

export default function TransactionHistoryPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [status, setStatus] = useState('');
  const [payout, setPayout] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const { data, isLoading, isFetching, error } = useQuery<TradeListResponse>({
    queryKey: queryKeys.history.trades(page, pageSize, status, payout, dateFrom, dateTo),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (status) params.set('status', status);
      if (payout) params.set('payout', payout);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      return api.get<TradeListResponse>(`/tradeins?${params.toString()}`);
    },
    placeholderData: (prev) => prev,
  });

  const pagination = data?.pagination;

  return (
    <div className="min-h-full bg-navy text-ink">
      <header className="sticky top-0 z-20 border-b border-track bg-navy/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-1 px-4 py-3 sm:px-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-brand">
            Transactions
          </p>
          <h1 className="text-xl font-semibold sm:text-2xl">History</h1>
          <p className="text-sm text-ink-muted">
            Every buy and trade intake, with a printable bill of sale for completed ones.
          </p>
        </div>
      </header>

      <section className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6 sm:py-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-muted">
              <span className="mb-1 block">Status</span>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand"
              >
                <option value="">All statuses</option>
                {TRADE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s] ?? s}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-ink-muted">
              <span className="mb-1 block">Type</span>
              <select
                value={payout}
                onChange={(e) => {
                  setPayout(e.target.value);
                  setPage(1);
                }}
                className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand"
              >
                <option value="">All types</option>
                {PAYOUT_KINDS.map((p) => (
                  <option key={p} value={p}>
                    {PAYOUT_LABELS[p] ?? p}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-ink-muted">
              <span className="mb-1 block">From</span>
              <input
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPage(1);
                }}
                className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </label>

            <label className="text-xs text-ink-muted">
              <span className="mb-1 block">To</span>
              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPage(1);
                }}
                className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </label>

            {(status || payout || dateFrom || dateTo) && (
              <button
                type="button"
                onClick={() => {
                  setStatus('');
                  setPayout('');
                  setDateFrom('');
                  setDateTo('');
                  setPage(1);
                }}
                className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-ink-muted transition hover:bg-track"
              >
                Clear filters
              </button>
            )}
          </div>

          <label className="text-xs text-ink-muted">
            <span className="mb-1 block">Per page</span>
            <select
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e.target.value) || 25);
                setPage(1);
              }}
              className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand"
            >
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>
        </div>

        {error && (
          <p className="mb-3 rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-sm text-rose-200">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {/* Mobile uses compact cards so operators never need to pan a wide table. */}
        <div className="space-y-2 sm:hidden">
          {isLoading &&
            Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="rounded-xl border border-track bg-card p-3">
                <div className="h-16 w-full animate-pulse rounded bg-track" />
              </div>
            ))}
          {!isLoading && data?.results.length === 0 && (
            <p className="rounded-xl border border-track bg-card px-3 py-8 text-center text-sm text-ink-muted">
              No transactions yet.
            </p>
          )}
          {!isLoading &&
            data?.results.map((trade) => (
              <article key={trade.id} className="rounded-xl border border-track bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <time
                        dateTime={trade.completedAt ?? trade.createdAt}
                        className="text-xs font-medium text-ink"
                      >
                        {new Date(trade.completedAt ?? trade.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: '2-digit',
                        })}
                      </time>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] leading-4 ${
                          STATUS_BADGE_CLASSES[trade.status] ?? STATUS_BADGE_CLASSES.draft
                        }`}
                      >
                        {STATUS_LABELS[trade.status] ?? trade.status}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm font-medium text-ink">
                      {trade.customerName ?? 'No customer'}
                    </p>
                    <p className="truncate text-[11px] text-ink-muted">
                      {PAYOUT_LABELS[trade.payout] ?? trade.payout} · {trade.itemCount} item
                      {trade.itemCount === 1 ? '' : 's'} · {trade.locationName}
                    </p>
                  </div>
                  <p className="shrink-0 font-mono text-sm font-semibold text-brand">
                    {formatCentsAsCurrency(trade.totalValueCents)}
                  </p>
                </div>
                {trade.status === 'completed' && (
                  <div className="mt-2 flex justify-end border-t border-track pt-2">
                    <ViewBillOfSaleButton trade={trade} />
                  </div>
                )}
              </article>
            ))}
        </div>

        <div className="hidden overflow-x-auto rounded-xl border border-track sm:block">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-card text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Bill of sale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-track">
              {isLoading &&
                Array.from({ length: 5 }, (_, i) => (
                  <tr key={i}>
                    <td colSpan={8} className="px-4 py-3">
                      <div className="h-4 w-full animate-pulse rounded bg-track" />
                    </td>
                  </tr>
                ))}
              {!isLoading && data?.results.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-ink-muted">
                    No transactions yet.
                  </td>
                </tr>
              )}
              {!isLoading &&
                data?.results.map((trade) => (
                  <tr key={trade.id} className="hover:bg-card/60">
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">
                      {new Date(trade.completedAt ?? trade.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{trade.customerName ?? '—'}</td>
                    <td className="px-4 py-3 text-ink-muted">{trade.locationName}</td>
                    <td className="px-4 py-3 text-ink-muted">
                      {PAYOUT_LABELS[trade.payout] ?? trade.payout}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          STATUS_BADGE_CLASSES[trade.status] ?? STATUS_BADGE_CLASSES.draft
                        }`}
                      >
                        {STATUS_LABELS[trade.status] ?? trade.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{trade.itemCount}</td>
                    <td className="px-4 py-3 text-right font-mono text-brand">
                      {formatCentsAsCurrency(trade.totalValueCents)}
                    </td>
                    <td className="px-4 py-3">
                      <ViewBillOfSaleButton trade={trade} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {pagination && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
            <p>
              Showing page {pagination.page.toLocaleString()} of {pagination.totalPages.toLocaleString()} (
              {pagination.total.toLocaleString()} transactions)
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={isFetching || page <= 1}
                className="min-h-9 rounded-lg border border-border bg-card px-3 py-1 text-xs font-semibold text-ink transition hover:bg-track disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pagination.totalPages || 1, p + 1))}
                disabled={isFetching || page >= (pagination.totalPages || 1)}
                className="min-h-9 rounded-lg border border-border bg-card px-3 py-1 text-xs font-semibold text-ink transition hover:bg-track disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
