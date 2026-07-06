import type { CardCondition, CardLanguage, CardPrinting, PayoutKind } from '@tcg/shared';
import { centsToMoney } from '../../../lib/transactions';
import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';

interface TradeDetailDrawerProps {
  trade: TradeModeTransactionController;
}

export default function TradeDetailDrawer({ trade }: TradeDetailDrawerProps) {
  const card = trade.selectedCard;
  const open = !!card;

  return (
    <>
      <div
        onClick={trade.clearTradeSelection}
        className={`fixed inset-0 z-30 bg-slate-950/60 transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden={!open}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Trade intake detail"
        className={`fixed inset-y-0 right-0 z-40 w-full border-l border-slate-800 bg-slate-900 shadow-2xl transition-transform sm:w-[480px] lg:w-[560px] ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {card && (
          <div className="flex h-full flex-col">
            <header className="flex items-start justify-between gap-2 border-b border-slate-800 p-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-bold" title={card.name}>
                  {card.name}
                </h2>
                <p className="truncate text-xs text-slate-400">
                  {[card.setName, card.number ? `#${card.number}` : null, card.rarity].filter(Boolean).join(' · ')}
                </p>
              </div>
              <button
                type="button"
                onClick={trade.clearTradeSelection}
                className="-m-1 shrink-0 p-1 text-slate-400 hover:text-slate-200"
                aria-label="Close"
              >
                ✕
              </button>
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <div className="flex items-center gap-3">
                <div className="h-20 w-14 shrink-0 overflow-hidden rounded bg-slate-800">
                  {card.imageUrl ? (
                    <img src={card.imageUrl} alt={card.name} className="h-full w-full object-contain" />
                  ) : null}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-semibold" title={card.name}>
                    {card.name}
                  </p>
                  <p className="text-xs text-slate-400">
                    {[card.setName, card.number].filter(Boolean).join(' • ')}
                  </p>
                  <p className="text-xs text-slate-500">
                    Market {trade.selectedMarketPriceCents == null ? '—' : centsToMoney(trade.selectedMarketPriceCents)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <EnumSelect<CardCondition>
                  value={trade.condition}
                  options={trade.conditionOptions}
                  onChange={trade.setCondition}
                />
                <EnumSelect<CardPrinting>
                  value={trade.printing}
                  options={trade.printingOptions}
                  onChange={trade.setPrinting}
                />
                <EnumSelect<CardLanguage>
                  value={trade.cardLanguage}
                  options={trade.cardLanguageOptions}
                  onChange={trade.setCardLanguage}
                />
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={trade.quantity}
                  onChange={(event) =>
                    trade.setQuantity(Math.max(1, Math.floor(Number(event.target.value) || 1)))
                  }
                  className="rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs"
                />
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                <EnumSelect<PayoutKind>
                  value={trade.payout}
                  options={['cash', 'store_credit']}
                  onChange={trade.setPayout}
                  labels={{ cash: 'Cash', store_credit: 'Store credit' }}
                />
                <input
                  type="number"
                  step="0.1"
                  value={trade.payoutModifierPercent}
                  onChange={(event) => trade.setPayoutModifierPercent(event.target.value)}
                  placeholder="Modifier %"
                  className="rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs"
                />
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={trade.overrideValue}
                  onChange={(event) => trade.setOverrideValue(event.target.value)}
                  placeholder="Override $"
                  className="rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs"
                />
              </div>
            </div>

            <footer className="border-t border-slate-800 bg-slate-900 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-700 bg-slate-950 p-2 text-xs">
                <span>
                  Suggested {centsToMoney(trade.suggestedTradeUnitCents)} • Line total {centsToMoney(trade.pendingLineTotalCents)}
                </span>
                <button
                  type="button"
                  onClick={trade.addTradeItemToQueue}
                  className="rounded bg-emerald-500 px-2 py-1 font-semibold text-slate-900"
                >
                  Add line item
                </button>
              </div>
            </footer>
          </div>
        )}
      </aside>
    </>
  );
}

interface EnumSelectProps<T extends string> {
  value: T;
  options: T[];
  onChange: (value: T) => void;
  labels?: Partial<Record<T, string>>;
}

function EnumSelect<T extends string>({ value, options, onChange, labels }: EnumSelectProps<T>) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {labels?.[option] ?? option}
        </option>
      ))}
    </select>
  );
}
