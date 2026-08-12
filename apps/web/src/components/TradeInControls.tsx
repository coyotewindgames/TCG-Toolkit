import type { ReactNode } from 'react';

interface TradeInFieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function TradeInField({ label, hint, children }: TradeInFieldProps) {
  return (
    <label className="block text-sm">
      <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500 mt-1">{hint}</span>}
    </label>
  );
}

interface TradeInChipProps {
  onClear: () => void;
  children: ReactNode;
}

export function TradeInChip({ onClear, children }: TradeInChipProps) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-200">
      {children}
      <button
        type="button"
        onClick={onClear}
        className="text-slate-400 hover:text-rose-300 leading-none"
        aria-label="Clear filter"
      >
        ✕
      </button>
    </span>
  );
}
