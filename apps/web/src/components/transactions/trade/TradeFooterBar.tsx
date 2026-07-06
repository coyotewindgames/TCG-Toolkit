import { centsToMoney } from '../../../lib/transactions';
import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';

interface TradeFooterBarProps {
  trade: TradeModeTransactionController;
  commitLabel: string;
}

export default function TradeFooterBar({ trade, commitLabel }: TradeFooterBarProps) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-700 bg-slate-900/95 p-3 backdrop-blur supports-[padding:max(0px)]:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Trade total</p>
          <p className="text-lg font-semibold">{centsToMoney(trade.queuedTradeTotalCents)}</p>
          <p className="text-xs text-slate-400">
            {trade.queuedItems.reduce((sum, item) => sum + item.quantity, 0)} cards • {trade.queuedItems.length} lines
          </p>
        </div>
        <button
          type="button"
          onClick={() => void trade.submitTrade()}
          disabled={!trade.queuedItems.length}
          className="min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400"
        >
          {commitLabel}
        </button>
      </div>
    </div>
  );
}
