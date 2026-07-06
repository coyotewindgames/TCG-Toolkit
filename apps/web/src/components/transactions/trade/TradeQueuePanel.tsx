import { Link } from 'react-router-dom';
import { centsToMoney } from '../../../lib/transactions';
import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';

interface TradeQueuePanelProps {
  trade: TradeModeTransactionController;
}

export default function TradeQueuePanel({ trade }: TradeQueuePanelProps) {
  return (
    <aside className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 lg:col-span-4">
      <h2 className="text-lg font-semibold">Current transaction</h2>
      <p className="mt-1 text-sm text-slate-300">Queued intake items for `/tradeins` batch submit.</p>

      <ul className="mt-4 space-y-2 text-sm text-slate-200">
        {trade.queuedItems.length === 0 ? (
          <li className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-slate-400">No items queued.</li>
        ) : (
          trade.queuedItems.map((item) => (
            <li key={item.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium" title={item.name}>{item.name}</p>
                  <p className="text-xs text-slate-400">{item.condition} / {item.printing} / {item.language}</p>
                  <p className="mt-1 text-xs text-slate-300">
                    {item.quantity} x {centsToMoney(item.estimatedUnitValueCents)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => trade.removeQueuedItem(item.id)}
                  className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Remove
                </button>
              </div>
            </li>
          ))
        )}
      </ul>

      {trade.tradeSubmitMsg && <p className="mt-3 text-xs text-emerald-300">{trade.tradeSubmitMsg}</p>}
      {trade.tradeSubmitErr && <p className="mt-3 break-all text-xs text-rose-300">{trade.tradeSubmitErr}</p>}

      {trade.labelInfo && (
        <div className="mt-4 flex items-center justify-between gap-2 rounded border border-slate-700 bg-slate-950 p-3">
          <div className="text-xs text-slate-300">
            QR labels ready for {trade.labelInfo.skuIds.reduce((sum, row) => sum + row.quantity, 0)} card
            {trade.labelInfo.skuIds.reduce((sum, row) => sum + row.quantity, 0) === 1 ? '' : 's'}.
            {trade.labelErr && <span className="mt-1 block text-rose-300">{trade.labelErr}</span>}
          </div>
          <button
            type="button"
            onClick={() => void trade.printLabels()}
            disabled={trade.printingLabels}
            className="rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700"
          >
            {trade.printingLabels ? 'Generating...' : 'Print labels'}
          </button>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
        <p className="text-xs text-slate-400">Fallback links</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link to="/tradein" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800">
            Legacy Trade-In
          </Link>
          <Link to="/register" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800">
            Legacy Register
          </Link>
          <Link to="/inventory" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800">
            Inventory tools
          </Link>
        </div>
      </div>
    </aside>
  );
}
