import { useState } from 'react';
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

/**
 * Buy / Trade UI.
 *
 * Layout:
 *  - Mobile: single column, mode-specific action bar at the bottom,
 *    cart opens as a slide-in sheet
 *  - Desktop: two-column grid with a sticky queue sidebar
 *
 * The card configuration drawer is triggered by selecting a card and floats
 * on top of both layouts.
 */
export default function TradeModeAdapter({ active, mode }: TradeModeAdapterProps) {
  const trade = useTradeTransaction(active, mode);
  const [queueOpen, setQueueOpen] = useState(false);

  if (!active) return null;

  const commitLabel = mode === 'buy' ? 'Create buy intake' : 'Create trade batch';

  return (
    <>
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <TradeSearchPanel trade={trade} />
        </div>

        <TradeQueuePanel
          trade={trade}
          openOnMobile={queueOpen}
          onCloseMobile={() => setQueueOpen(false)}
        />
      </section>

      {/* Line-item configuration slides in when a card is selected */}
      <TradeDetailDrawer trade={trade} />

      {/* Sticky bottom bar: shows cart summary + primary commit action */}
      <TradeFooterBar
        trade={trade}
        commitLabel={commitLabel}
        onOpenQueue={() => setQueueOpen(true)}
      />
    </>
  );
}
