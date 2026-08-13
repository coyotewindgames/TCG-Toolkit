import { useEffect } from 'react';
import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';
import CardImage from '../CardImage';
import { formatCentsAsCurrency } from '../../../lib/format';

interface TradeDetailDrawerProps {
  trade: TradeModeTransactionController;
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
        className={`fixed inset-0 z-40 bg-navy/70 transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        aria-label="Configure trade item"
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-track bg-card shadow-2xl transition-transform ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {trade.selectedCard && (
          <>
            <header className="flex items-start justify-between gap-3 border-b border-track px-4 py-3">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-brand">
                  Configure line item
                </p>
                <h3 className="mt-0.5 truncate text-lg font-semibold" title={trade.selectedCard.name}>
                  {trade.selectedCard.name}
                </h3>
                <p className="truncate text-xs text-ink-muted">
                  {trade.selectedCard.setName ?? ''}
                  {trade.selectedCard.number ? ` • #${trade.selectedCard.number}` : ''}
                  {trade.selectedCard.rarity ? ` • ${trade.selectedCard.rarity}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={trade.clearTradeSelection}
                aria-label="Close"
                className="rounded p-1 text-ink-muted hover:bg-track hover:text-ink"
              >
                ✕
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="w-full sm:w-40">
                  <div className="aspect-[3/4] overflow-hidden rounded-xl border border-track bg-track">
                    <CardImage
                      src={trade.selectedCard.imageUrl}
                      alt={trade.selectedCard.name}
                    />
                  </div>
                  <div className="mt-3 rounded-lg border border-track bg-navy/60 p-2 text-xs text-ink-muted">
                    <p>
                      Market:{' '}
                      <span className="font-mono">{formatCentsAsCurrency(trade.selectedMarketPriceCents)}</span>
                    </p>
                    <p>
                      Suggested:{' '}
                      <span className="font-mono text-brand">
                        {formatCentsAsCurrency(trade.suggestedTradeUnitCents)}
                      </span>
                    </p>
                    <p>
                      Line total:{' '}
                      <span className="font-mono text-brand">
                        {formatCentsAsCurrency(trade.pendingLineTotalCents)}
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

            <footer className="border-t border-track px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={trade.clearTradeSelection}
                  className="min-h-11 rounded-lg border border-border bg-card px-4 text-sm font-semibold text-ink transition hover:bg-track"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    trade.addTradeItemToQueue();
                    trade.clearTradeSelection();
                  }}
                  className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-navy transition hover:bg-brand-dark"
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
      <span className="mb-1 block font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="min-h-11 w-full rounded-lg border border-border bg-navy px-3 text-sm outline-none focus:border-brand"
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
      <span className="mb-1 block font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
        className="min-h-11 w-full rounded-lg border border-border bg-navy px-3 text-sm outline-none focus:border-brand"
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
      <span className="mb-1 block font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <input
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full rounded-lg border border-border bg-navy px-3 text-sm outline-none focus:border-brand"
      />
    </label>
  );
}
