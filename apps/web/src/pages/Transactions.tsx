import { useState } from 'react';
import ModeSwitch from '../components/transactions/ModeSwitch';
import SellModeAdapter from '../components/transactions/SellModeAdapter';
import TradeModeAdapter from '../components/transactions/TradeModeAdapter';
import type { TransactionMode } from '../lib/transactions';

const MODE_META: Record<TransactionMode, { title: string; helper: string }> = {
  buy: {
    title: 'Buy Intake',
    helper: 'Receive cards from customers and build an intake batch.',
  },
  sell: {
    title: 'Sell Checkout',
    helper: 'Scan or search inventory, then complete a customer sale.',
  },
  trade: {
    title: 'Trade Intake',
    helper: 'Collect cards, review value, and create a trade batch.',
  },
};

export default function TransactionsPage() {
  const [mode, setMode] = useState<TransactionMode>('sell');
  const meta = MODE_META[mode];

  return (
    <div className="min-h-full bg-slate-950 text-slate-100">
      {/* Sticky page header — keeps mode switch reachable while scrolling result grids */}
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-emerald-300">
                Transactions
              </p>
              <h1 className="mt-0.5 truncate text-xl font-semibold sm:text-2xl" title={meta.title}>
                {meta.title}
              </h1>
            </div>
            <ModeSwitch value={mode} onChange={setMode} />
          </div>
          <p className="text-sm text-slate-400">{meta.helper}</p>
        </div>
      </header>

      {/* Extra bottom padding leaves room for the sticky action bar on mobile */}
      <section className="mx-auto w-full max-w-7xl px-4 pb-32 pt-4 sm:px-6 sm:pt-6">
        <SellModeAdapter active={mode === 'sell'} />
        <TradeModeAdapter active={mode === 'trade' || mode === 'buy'} mode={mode} />
      </section>
    </div>
  );
}
