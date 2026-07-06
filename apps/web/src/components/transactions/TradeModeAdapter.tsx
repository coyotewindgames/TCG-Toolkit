import { useTradeTransaction } from '../../hooks/transactions/useTradeTransaction';
import type { TransactionMode } from '../../lib/transactions';
import TradeSearchPanel from './trade/TradeSearchPanel';
import TradeDetailDrawer from './trade/TradeDetailDrawer';
import TradeQueuePanel from './trade/TradeQueuePanel';
import TradeFooterBar from './trade/TradeFooterBar';

interface TradeModeAdapterProps {
  active: boolean;
  mode: TransactionMode;
}

export default function TradeModeAdapter({ active, mode }: TradeModeAdapterProps) {
  const trade = useTradeTransaction(active, mode);
  const title = mode === 'buy' ? 'Buy Intake' : 'Trade Intake';
  const helper =
    mode === 'buy'
      ? 'Receive cards from customers, value them, and create a buy intake batch.'
      : 'Collect cards, review value, and create a trade batch.';
  const commitLabel = mode === 'buy' ? 'Create buy intake' : 'Create trade batch';

  return (
    <section hidden={!active} aria-hidden={!active} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 lg:col-span-8">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-slate-300">{helper}</p>
          <TradeSearchPanel trade={trade} />
        </article>

        <TradeQueuePanel trade={trade} />
      </div>
      <TradeDetailDrawer trade={trade} />
      <TradeFooterBar trade={trade} commitLabel={commitLabel} />
    </section>
  );
}
