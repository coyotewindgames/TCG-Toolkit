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
                      {trade.isGraded ? 'Graded median:' : 'Market:'}{' '}
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
                  <GradedCardSection trade={trade} />
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

/**
 * "Slabs" as a first-class option: lets the operator switch this line item
 * between "Ungraded" (condition/printing) and "Graded" (grading company +
 * grade, with a live median pulled from recent eBay sold comps via
 * `GET /pkmnprices/cards/:id/graded-price` instead of manually searching
 * eBay). Selecting a grade also drives the suggested payout for the queued
 * line item.
 */
function GradedCardSection({ trade }: { trade: TradeModeTransactionController }) {
  const ebayGradedUrl = trade.isGraded
    ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(
        `${trade.selectedCard?.name ?? ''} ${trade.gradingCompany} ${trade.grade}`,
      )}&LH_Complete=1&LH_Sold=1`
    : null;

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Card condition type" className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-navy p-1">
        <button
          type="button"
          role="tab"
          aria-selected={!trade.isGraded}
          onClick={() => trade.setIsGraded(false)}
          className={`min-h-9 rounded-md text-sm font-semibold transition ${
            !trade.isGraded ? 'bg-brand text-navy' : 'text-ink-muted hover:text-ink'
          }`}
        >
          Ungraded
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={trade.isGraded}
          onClick={() => trade.setIsGraded(true)}
          className={`min-h-9 rounded-md text-sm font-semibold transition ${
            trade.isGraded ? 'bg-brand text-navy' : 'text-ink-muted hover:text-ink'
          }`}
        >
          Graded / slab
        </button>
      </div>

      {!trade.isGraded && (
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
      )}

      {trade.isGraded && (
        <div className="space-y-3 rounded-xl border border-border bg-navy p-3">
          <Row>
            <EnumSelect
              label="Grading company"
              value={trade.gradingCompany}
              options={trade.gradingCompanyOptions}
              onChange={(next) => {
                trade.setGradingCompany(next);
                trade.setGrade('10');
              }}
            />
            <label className="block text-xs">
              <span className="mb-1 block font-medium uppercase tracking-wide text-ink-muted">Grade</span>
              <select
                value={trade.grade}
                onChange={(event) => trade.setGrade(event.target.value)}
                className="min-h-11 w-full rounded-lg border border-border bg-navy px-3 text-sm outline-none focus:border-brand"
              >
                {trade.gradeOptions.map((g) => (
                  <option key={g} value={g}>
                    {trade.gradingCompany.toUpperCase()} {g}
                  </option>
                ))}
              </select>
            </label>
          </Row>

          <TextField
            label="Cert number (optional)"
            value={trade.certNumber}
            onChange={trade.setCertNumber}
            placeholder="e.g. 12345678"
          />

          <div className="rounded-lg border border-border bg-track px-3 py-2">
            {trade.gradedPriceLoading ? (
              <p className="text-xs text-ink-dim">
                Checking recent {trade.gradingCompany.toUpperCase()} {trade.grade} sales…
              </p>
            ) : trade.gradedPriceError ? (
              <p className="text-xs text-rose-300">Couldn't fetch graded pricing — use Override value.</p>
            ) : trade.gradedPrice?.medianCents != null ? (
              <p className="text-sm text-ink">
                <span className="font-semibold">{formatCentsAsCurrency(trade.gradedPrice.medianCents)}</span>{' '}
                <span className="text-xs text-ink-dim">
                  median · {trade.gradedPrice.sampleSize} recent {trade.gradingCompany.toUpperCase()} {trade.grade} sale
                  {trade.gradedPrice.sampleSize === 1 ? '' : 's'} (90d)
                </span>
              </p>
            ) : (
              <p className="text-xs text-ink-dim">
                Not enough recent {trade.gradingCompany.toUpperCase()} {trade.grade} sales to suggest a price — use
                Override value.
              </p>
            )}
          </div>

          {ebayGradedUrl && (
            <a
              href={ebayGradedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 underline underline-offset-2 hover:text-blue-300"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              View {trade.gradingCompany.toUpperCase()} {trade.grade} recently sold on eBay
            </a>
          )}
          <p className="text-[11px] text-ink-dim">
            Graded prices vary by pop report — use Override value to fine-tune the exact payout.
          </p>
        </div>
      )}
    </div>
  );
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
