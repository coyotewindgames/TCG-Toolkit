import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';

interface TradeQueuePanelProps {
  trade: TradeModeTransactionController;
  openOnMobile: boolean;
  onCloseMobile: () => void;
}

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Queue / cart sidebar.
 *
 * On mobile it slides in from the right as an overlay. On lg+ it renders as a
 * sticky sidebar column and the mobile-only overlay classes become no-ops.
 */
export default function TradeQueuePanel({ trade, openOnMobile, onCloseMobile }: TradeQueuePanelProps) {
  return (
    <>
      <div
        onClick={onCloseMobile}
        aria-hidden={!openOnMobile}
        className={`fixed inset-0 z-30 bg-slate-950/60 transition-opacity lg:hidden ${
          openOnMobile ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        aria-label="Trade queue"
        className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-slate-800 bg-slate-900 shadow-2xl transition-transform lg:static lg:col-span-4 lg:z-auto lg:max-w-none lg:translate-x-0 lg:rounded-2xl lg:border lg:shadow-none ${
          openOnMobile ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="flex h-full flex-col lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)]">
          <header className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3 lg:border-b-0 lg:pb-2">
            <div>
              <h2 className="text-base font-semibold">Queue</h2>
              <p className="text-xs text-slate-400">
                {trade.queuedItems.length === 0
                  ? 'No items yet'
                  : `${trade.queuedItems.length} line${trade.queuedItems.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close queue"
              className="rounded p-1 text-slate-400 hover:text-slate-100 lg:hidden"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-2">
            {trade.queuedItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/60 p-4 text-center text-xs text-slate-400">
                Select a card from the search results, then add it to the queue.
              </div>
            ) : (
              <ul className="space-y-2">
                {trade.queuedItems.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-xl border border-slate-800 bg-slate-950/70 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold" title={item.name}>
                          {item.name}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {item.condition} • {item.printing} • {item.language} • Qty {item.quantity}
                        </p>
                        <p className="mt-1 font-mono text-xs text-emerald-300">
                          {formatCents(item.estimatedUnitValueCents * item.quantity)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => trade.removeQueuedItem(item.id)}
                        aria-label={`Remove ${item.name}`}
                        className="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-rose-300"
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {trade.tradeSubmitMsg && (
              <p className="mt-3 rounded-lg border border-emerald-800/60 bg-emerald-950/40 p-2 text-xs text-emerald-200">
                {trade.tradeSubmitMsg}
              </p>
            )}
            {trade.tradeSubmitErr && (
              <p className="mt-3 rounded-lg border border-rose-800/60 bg-rose-950/40 p-2 text-xs text-rose-200">
                {trade.tradeSubmitErr}
              </p>
            )}

            {trade.labelInfo && (
              <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
                <p className="mb-2 font-medium text-slate-100">Print QR labels</p>
                <p className="mb-2 text-slate-400">
                  {trade.labelInfo.skuIds.length} SKU
                  {trade.labelInfo.skuIds.length === 1 ? '' : 's'} ready for{' '}
                  {trade.labelInfo.cardName}.
                </p>
                <button
                  type="button"
                  onClick={() => void trade.printLabels()}
                  disabled={trade.printingLabels}
                  className="min-h-9 rounded-lg bg-slate-700 px-3 py-1 text-xs font-semibold text-slate-100 transition hover:bg-slate-600 disabled:opacity-50"
                >
                  {trade.printingLabels ? 'Printing…' : 'Print labels'}
                </button>
                {trade.labelErr && <p className="mt-2 text-rose-300">{trade.labelErr}</p>}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
