import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

interface TradeFooterBarProps {
  trade: TradeModeTransactionController;
  commitLabel: string;
  onOpenQueue: () => void;
}

/**
 * Sticky bottom bar for Trade / Buy modes.
 *
 * On mobile the queue button opens the queue sheet. On lg+ the queue sidebar
 * is already visible, so the button collapses out to save space.
 */
export default function TradeFooterBar({ trade, commitLabel, onOpenQueue }: TradeFooterBarProps) {
  const disabled = trade.queuedItems.length === 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-950/95 p-3 backdrop-blur supports-[padding:max(0px)]:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onOpenQueue}
          className="flex min-h-11 flex-1 items-center justify-between rounded-lg border border-slate-700 bg-slate-900 px-3 text-left text-sm lg:hidden"
        >
          <span>
            <span className="block text-[10px] uppercase tracking-wide text-slate-400">Queue</span>
            <span className="font-semibold text-slate-100">
              {trade.queuedItems.length} line{trade.queuedItems.length === 1 ? '' : 's'}
            </span>
          </span>
          <span className="font-mono text-emerald-300">
            {formatCents(trade.queuedTradeTotalCents)}
          </span>
        </button>

        <div className="hidden min-w-0 flex-1 items-baseline gap-4 lg:flex">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Trade total
            </p>
            <p className="text-xl font-semibold">{formatCents(trade.queuedTradeTotalCents)}</p>
          </div>
          <p className="text-xs text-slate-400">
            {trade.queuedItems.length} line{trade.queuedItems.length === 1 ? '' : 's'} queued
          </p>
        </div>

        <button
          type="button"
          onClick={() => void trade.submitTrade()}
          disabled={disabled}
          className="min-h-11 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400"
        >
          {commitLabel}
        </button>
      </div>
    </div>
  );
}
