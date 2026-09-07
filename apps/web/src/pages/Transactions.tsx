import { useState } from 'react';
import ModeSwitch from '../components/transactions/ModeSwitch';
import RegisterAdapter from '../components/transactions/RegisterAdapter';
import type { TransactionMode } from '../lib/transactions';

const MODE_META: Record<TransactionMode, { title: string; helper: string }> = {
  buy: {
    title: 'Buy',
    helper: 'Search the catalog, value cards for a cash payout, and create a buy intake.',
  },
  sell: {
    title: 'Sell',
    helper: 'Search or scan your inventory and complete a customer sale.',
  },
  trade: {
    title: 'Trade',
    helper: 'Value cards for store credit and create a trade intake.',
  },
};

export default function TransactionsPage() {
  const [mode, setMode] = useState<TransactionMode>('sell');
  const meta = MODE_META[mode];

  return (
    <div className="min-h-full bg-navy text-ink">
      {/* Sticky page header — keeps mode switch reachable while scrolling result grids */}
      <header className="sticky top-0 z-20 border-b border-track bg-navy/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-brand">
                Register
              </p>
              {/* Single, stable page identity across all three modes; the
                  mode-specific label moves to the subtitle so switching modes
                  never reflows the header. */}
              <h1 className="mt-0.5 truncate text-xl font-semibold sm:text-2xl">
                Buy · Sell · Trade
              </h1>
            </div>
            <ModeSwitch value={mode} onChange={setMode} />
          </div>
          <p className="text-sm text-ink-muted">
            <span className="font-medium text-ink">{meta.title}.</span> {meta.helper}
          </p>
        </div>
      </header>

      {/* Extra bottom padding leaves room for the sticky action bar on mobile */}
      <section className="mx-auto w-full max-w-7xl px-4 pb-32 pt-4 sm:px-6 sm:pt-6">
        <RegisterAdapter mode={mode} />
      </section>
    </div>
  );
}
