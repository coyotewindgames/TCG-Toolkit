import type { TransactionMode } from '../../lib/transactions';
import { TRANSACTION_MODES } from '../../lib/transactions';

interface ModeSwitchProps {
  value: TransactionMode;
  onChange: (next: TransactionMode) => void;
}

export default function ModeSwitch({ value, onChange }: ModeSwitchProps) {
  return (
    <div className="inline-flex w-full rounded-xl border border-border bg-card p-1 sm:w-auto" role="tablist" aria-label="Transaction mode">
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
                ? 'bg-brand-dark text-navy'
                : 'text-ink-muted hover:bg-track hover:text-ink'
            }`}
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
