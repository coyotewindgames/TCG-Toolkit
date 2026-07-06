import { useState } from 'react';
import { Link } from 'react-router-dom';
import ModeSwitch from '../components/transactions/ModeSwitch';
import SellModeAdapter from '../components/transactions/SellModeAdapter';
import TradeModeAdapter from '../components/transactions/TradeModeAdapter';
import type { TransactionMode } from '../lib/transactions';

const MODE_HELPER: Record<TransactionMode, string> = {
  buy: 'Receive cards from customers and build an intake batch.',
  sell: 'Scan inventory and complete a customer sale.',
  trade: 'Collect cards, review value, and create a trade batch.',
};

export default function TransactionsPage() {
  const [mode, setMode] = useState<TransactionMode>('sell');

  return (
    <div className="min-h-full bg-slate-950 text-slate-100">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 pb-28 sm:p-6 sm:pb-28">
        <header className="space-y-3">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Transactions</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h1 className="text-2xl font-semibold">Unified Buy / Sell / Trade</h1>
            <ModeSwitch value={mode} onChange={setMode} />
          </div>
          <p className="max-w-2xl text-sm text-slate-300">{MODE_HELPER[mode]}</p>
        </header>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
          Legacy routes remain available during rollout:
          <div className="mt-2 flex flex-wrap gap-2">
            <Link to="/register" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800">
              Register
            </Link>
            <Link to="/tradein" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800">
              Trade-In
            </Link>
            <Link to="/inventory" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800">
              Inventory
            </Link>
          </div>
        </div>

        <SellModeAdapter active={mode === 'sell'} />
        <TradeModeAdapter active={mode === 'trade' || mode === 'buy'} mode={mode} />
      </section>
    </div>
  );
}
