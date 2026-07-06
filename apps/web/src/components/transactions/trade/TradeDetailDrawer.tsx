import { useEffect } from 'react';
import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';

interface TradeDetailDrawerProps {
  trade: TradeModeTransactionController;
}

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Full-screen (mobile) / side-sheet (desktop) card configuration drawer.
 * Opens whenever the user selects a card in the search grid.
 */
export default function TradeDetailDrawer({ trade }: TradeDetailDrawerProps) {
  const open = !!trade.selectedCard;

  // Escape closes the drawer for keyboard users
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') trade.clearTradeSelection();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, trade]);

  return (
    <>
      <div
        onClick={trade.clearTradeSelection}
        aria-hidden={!open}
        className={`fixed inset-0 z-40 bg-slate-950/70 transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        aria-label="Configure trade item"
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-slate-800 bg-slate-900 shadow-2xl transition-transform ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {trade.selectedCard && (
          <>
            <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                  Configure line item
                </p>
                <h3 className="mt-0.5 truncate text-lg font-semibold" title={trade.selectedCard.name}>
                  {trade.selectedCard.name}
                </h3>
                <p className="truncate text-xs text-slate-400">
                  {trade.selectedCard.setName ?? ''}
                  {trade.selectedCard.number ? ` • #${trade.selectedCard.number}` : ''}
                  {trade.selectedCard.rarity ? ` • ${trade.selectedCard.rarity}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={trade.clearTradeSelection}
                aria-label="Close"
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              >
                ✕
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="w-full sm:w-40">
                  <div className="aspect-[3/4] overflow-hidden rounded-xl border border-slate-800 bg-slate-800">
                    {trade.selectedCard.imageUrl && (
                      <img
                        src={trade.selectedCard.imageUrl}
                        alt={trade.selectedCard.name}
                        className="h-full w-full object-contain"
                        loading="lazy"
                      />
                    )}
                  </div>
                  <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 p-2 text-xs text-slate-300">
                    <p>
                      Market:{' '}
                      <span className="font-mono">{formatCents(trade.selectedMarketPriceCents)}</span>
                    </p>
                    <p>
                      Suggested:{' '}
                      <span className="font-mono text-emerald-300">
                        {formatCents(trade.suggestedTradeUnitCents)}
                      </span>
                    </p>
                    <p>
                      Line total:{' '}
                      <span className="font-mono text-emerald-300">
                        {formatCents(trade.pendingLineTotalCents)}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="min-w-0 flex-1 space-y-3">
                  <Row>
                    <EnumSelect
                      label="Condition"
                      value={trade.condition}
                      options={trade.conditionOptions}
                      onChange={trade.setCondition}
                    />
                    <EnumSelect
                      label="Printing"
                      value={trade.printing}
                      options={trade.printingOptions}
                      onChange={trade.setPrinting}
                    />
                  </Row>
                  <Row>
                    <EnumSelect
                      label="Language"
                      value={trade.cardLanguage}
                      options={trade.cardLanguageOptions}
                      onChange={trade.setCardLanguage}
                    />
                    <NumberField
                      label="Quantity"
                      min={1}
                      value={trade.quantity}
                      onChange={(next) => trade.setQuantity(Math.max(1, next))}
                    />
                  </Row>
                  <Row>
                    <EnumSelect
                      label="Payout"
                      value={trade.payout}
                      options={['cash', 'store_credit']}
                      onChange={trade.setPayout}
                    />
                    <TextField
                      label="Payout modifier %"
                      value={trade.payoutModifierPercent}
                      onChange={trade.setPayoutModifierPercent}
                      placeholder="0"
                      inputMode="decimal"
                    />
                  </Row>
                  <TextField
                    label="Override value ($)"
                    value={trade.overrideValue}
                    onChange={trade.setOverrideValue}
                    placeholder="Leave blank to use suggested"
                    inputMode="decimal"
                  />
                </div>
              </div>
            </div>

            <footer className="border-t border-slate-800 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={trade.clearTradeSelection}
                  className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-4 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    trade.addTradeItemToQueue();
                    trade.clearTradeSelection();
                  }}
                  className="min-h-11 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
                >
                  Add to queue
                </button>
              </div>
            </footer>
          </>
        )}
      </aside>
    </>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;
}

function EnumSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-emerald-500"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min?: number;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
        className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-emerald-500"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  inputMode?: 'decimal' | 'numeric' | 'text';
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <input
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-emerald-500"
      />
    </label>
  );
}
