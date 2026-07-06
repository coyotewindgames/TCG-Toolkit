import type { TransactionMode } from '../../lib/transactions';
import { TRANSACTION_MODES } from '../../lib/transactions';

interface ModeSwitchProps {
  value: TransactionMode;
  onChange: (next: TransactionMode) => void;
}

export default function ModeSwitch({ value, onChange }: ModeSwitchProps) {
  return (
    <div className="inline-flex w-full rounded-xl border border-slate-700 bg-slate-900 p-1 sm:w-auto" role="tablist" aria-label="Transaction mode">
      {TRANSACTION_MODES.map((mode) => {
        const active = mode.id === value;
        return (
          <button
            key={mode.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(mode.id)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors sm:flex-none ${
              active
                ? 'bg-emerald-400 text-slate-950'
                : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
            }`}
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
