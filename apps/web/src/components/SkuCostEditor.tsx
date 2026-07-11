/**
 * Small modal for correcting a SKU's "picked up at" (cost basis) price.
 *
 * Cost basis is normally set automatically by the trade-in flow — each item
 * receives the operator's suggested value, and the inventory service tracks
 * a weighted-average. This editor is the escape hatch for the two common
 * cases where the auto-value is wrong:
 *   1. The card was acquired outside the trade-in flow (e.g. a cash bulk buy).
 *   2. A prior trade was entered at the wrong value and needs correcting so
 *      P&L / margin math is accurate going forward.
 *
 * Owner/manager only — cost basis feeds directly into the store's reporting.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface SkuCostEditorProps {
  sku: {
    id: string;
    condition: string;
    printing: string;
    language: string;
    avgCostCents: number | null;
  };
  productName: string;
  onClose: () => void;
  /** Called with the newly persisted cents value so the caller can refresh caches. */
  onSaved: (costCents: number) => void;
}

export default function SkuCostEditor({ sku, productName, onClose, onSaved }: SkuCostEditorProps) {
  const initialDollars =
    typeof sku.avgCostCents === 'number' && sku.avgCostCents > 0
      ? (sku.avgCostCents / 100).toFixed(2)
      : '';
  const [value, setValue] = useState<string>(initialDollars);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function onSave() {
    setError(null);
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Enter a cost in dollars (0 or greater).');
      return;
    }
    const dollars = Number(trimmed);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError('Enter a valid non-negative dollar amount.');
      return;
    }
    const costCents = Math.round(dollars * 100);
    setBusy(true);
    try {
      await api.post(`/inventory/skus/${sku.id}/cost`, { costCents });
      onSaved(costCents);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close cost editor"
        className="absolute inset-0 bg-black/70"
        onClick={() => (busy ? null : onClose())}
      />
      <div className="relative w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Edit purchased-at price</h2>
            <p className="text-sm text-slate-400 line-clamp-1">{productName}</p>
            <p className="mt-1 text-xs text-slate-500">
              {sku.condition} · {sku.printing} · {sku.language}
            </p>
          </div>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-200 text-sm"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Cost per unit (USD)
          </span>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              $
            </span>
            <input
              autoFocus
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0.00"
              className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 pl-7 pr-3 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/40"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void onSave();
              }}
            />
          </div>
        </label>

        <p className="mt-2 text-xs text-slate-500">
          Applies to every stock row for this SKU across all locations.
        </p>

        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary disabled:opacity-50"
            onClick={() => void onSave()}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save cost'}
          </button>
        </div>
      </div>
    </div>
  );
}
