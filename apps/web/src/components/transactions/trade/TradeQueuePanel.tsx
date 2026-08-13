import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';
import { formatCentsAsCurrency } from '../../../lib/format';

interface TradeQueuePanelProps {
  trade: TradeModeTransactionController;
  openOnMobile: boolean;
  onCloseMobile: () => void;
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
        className={`fixed inset-0 z-30 bg-navy/60 transition-opacity lg:hidden ${
          openOnMobile ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        aria-label="Trade queue"
        className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-track bg-card shadow-2xl transition-transform lg:static lg:col-span-4 lg:z-auto lg:max-w-none lg:translate-x-0 lg:rounded-2xl lg:border lg:shadow-none ${
          openOnMobile ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="flex h-full flex-col lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)]">
          <header className="flex items-center justify-between gap-2 border-b border-track px-4 py-3 lg:border-b-0 lg:pb-2">
            <div>
              <h2 className="text-base font-semibold">Queue</h2>
              <p className="text-xs text-ink-muted">
                {trade.queuedItems.length === 0
                  ? 'No items yet'
                  : `${trade.queuedItems.length} line${trade.queuedItems.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close queue"
              className="rounded p-1 text-ink-muted hover:text-ink lg:hidden"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-2">
            {trade.queuedItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-navy/60 p-4 text-center text-xs text-ink-muted">
                Select a card from the search results, then add it to the queue.
              </div>
            ) : (
              <ul className="space-y-2">
                {trade.queuedItems.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-xl border border-track bg-navy/70 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold" title={item.name}>
                          {item.name}
                        </p>
                        <p className="text-[11px] text-ink-muted">
                          {item.gradingCompany
                            ? `${item.gradingCompany.toUpperCase()} ${item.grade}`
                            : item.condition}{' '}
                          • {item.printing} • {item.language} • Qty {item.quantity}
                        </p>
                        {item.certNumber && (
                          <p className="text-[11px] text-ink-dim">Cert #{item.certNumber}</p>
                        )}
                        <p className="mt-1 font-mono text-xs text-brand">
                          {formatCentsAsCurrency(item.estimatedUnitValueCents * item.quantity)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => trade.removeQueuedItem(item.id)}
                        aria-label={`Remove ${item.name}`}
                        className="rounded p-1 text-ink-dim transition hover:bg-track hover:text-rose-300"
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {trade.tradeSubmitMsg && (
              <p className="mt-3 rounded-lg border border-brand-dark/60 bg-brand/40 p-2 text-xs text-brand">
                {trade.tradeSubmitMsg}
              </p>
            )}
            {trade.tradeSubmitErr && (
              <p className="mt-3 rounded-lg border border-rose-800/60 bg-rose-950/40 p-2 text-xs text-rose-200">
                {trade.tradeSubmitErr}
              </p>
            )}

            {trade.labelInfo && (
              <div className="mt-3 rounded-lg border border-track bg-navy/60 p-3 text-xs text-ink-muted">
                <p className="mb-2 font-medium text-ink">Print QR labels</p>
                <p className="mb-2 text-ink-muted">
                  {trade.labelInfo.skuIds.length} SKU
                  {trade.labelInfo.skuIds.length === 1 ? '' : 's'} ready for{' '}
                  {trade.labelInfo.cardName}.
                </p>
                <button
                  type="button"
                  onClick={() => void trade.printLabels()}
                  disabled={trade.printingLabels}
                  className="min-h-9 rounded-lg bg-track px-3 py-1 text-xs font-semibold text-ink transition hover:bg-card disabled:opacity-50"
                >
                  {trade.printingLabels ? 'Printing…' : 'Print labels'}
                </button>
                {trade.labelErr && <p className="mt-2 text-rose-300">{trade.labelErr}</p>}
              </div>
            )}

            {trade.completedTradeId && (
              <div className="mt-3 rounded-lg border border-track bg-navy/60 p-3 text-xs text-ink-muted">
                <p className="mb-2 font-medium text-ink">Bill of sale</p>
                <p className="mb-2 text-ink-muted">
                  A signed record of this transaction opened automatically. Reprint it here if needed.
                </p>
                <button
                  type="button"
                  onClick={() => void trade.printBillOfSaleForTrade()}
                  disabled={trade.printingBillOfSale}
                  className="min-h-9 rounded-lg bg-track px-3 py-1 text-xs font-semibold text-ink transition hover:bg-card disabled:opacity-50"
                >
                  {trade.printingBillOfSale ? 'Opening…' : 'Print bill of sale'}
                </button>
                {trade.billOfSaleErr && <p className="mt-2 text-rose-300">{trade.billOfSaleErr}</p>}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
