import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CatalogCard } from '@tcg/shared';
import type { TransactionMode } from '../../lib/transactions';
import { formatCentsAsCurrency } from '../../lib/format';
import { useSellTransaction } from '../../hooks/transactions/useSellTransaction';
import { useTradeTransaction } from '../../hooks/transactions/useTradeTransaction';
import CardImage from './CardImage';
import TransactionEntryBar from './TransactionEntryBar';
import SearchableSelect from '../SearchableSelect';
import { SellSkuList, SellSearchStatus } from './SellModeAdapterParts';
import TradeDetailDrawer from './trade/TradeDetailDrawer';

interface RegisterAdapterProps {
  /** Current top-level intent. Drives result ordering + intake payout (buy=cash,
   * trade=store credit). Sell items are added by picking an in-stock SKU. */
  mode: TransactionMode;
}

/**
 * Unified Buy / Sell / Trade register (Phase 2 + 3).
 *
 * Composes the two proven flow controllers — `useSellTransaction` (server order
 * + Clover checkout, in-stock SKUs) and `useTradeTransaction` (catalog intake
 * valued for payout, submitted to /tradeins) — behind a single surface:
 *
 *  - Phase 3, one search: a single query drives BOTH the local-inventory search
 *    and the catalog search; results render in one grid, tagged "In stock" vs
 *    "Catalog". Picking an in-stock card lists its SKUs to add to the sale;
 *    picking a catalog card opens the value drawer to add to the buy/trade queue.
 *  - Phase 2, one cart: sell lines and buy/trade lines live in one panel, each
 *    badged with its intent, above a combined "customer pays / store pays / net
 *    cash" summary. The two settlement actions stay distinct (a sale finalizes
 *    through Clover; an intake creates a trade-in) so no money math is merged,
 *    but the operator works from a single cart.
 *
 * The top-level mode switch selects the intake payout (Buy → cash, Trade → store
 * credit) and which result group leads; sell is implicit in picking a stocked SKU.
 */
export default function RegisterAdapter({ mode }: RegisterAdapterProps) {
  const queryClient = useQueryClient();
  const sell = useSellTransaction(true);
  // The trade controller only distinguishes buy vs trade (payout). In "sell"
  // mode we still allow intake and default it to a cash buy.
  const intakeMode = mode === 'trade' ? 'trade' : 'buy';
  const trade = useTradeTransaction(true, intakeMode);

  // Single query mirrored to both underlying search controllers (Phase 3).
  const [query, setQuery] = useState('');
  function handleQueryChange(value: string) {
    setQuery(value);
    sell.setSellQuery(value);
    trade.setQuery(value);
    sell.selectProduct(null);
  }

  const paid = sell.sellStatus === 'paid';

  // Net cash: what the customer pays for their purchase, minus what the store
  // pays out for cash buys. Trade-ins settle as store credit, so they don't
  // move the cash drawer — surfaced separately below. `queuedTradeTotalCents`
  // is the queue's own payout total (already reflects the buy/trade multiplier).
  const customerPaysCents = sell.totals.totalCents;
  const intakeTotalCents = trade.queuedTradeTotalCents;
  const storePaysCents = intakeMode === 'buy' ? intakeTotalCents : 0;
  const storeCreditCents = intakeMode === 'trade' ? intakeTotalCents : 0;
  const netCashCents = customerPaysCents - storePaysCents;

  const leadWithInventory = mode === 'sell';

  const inventoryResults = (
    <ResultGroup
      title="In your inventory"
      badge="In stock"
      empty={
        <SellSearchStatus
          fetching={sell.searchingCards}
          error={sell.cardSearchError}
          hasQuery={query.trim().length >= 2}
          resultCount={sell.cardResults.length}
        />
      }
    >
      {sell.cardResults.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {sell.cardResults.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                onClick={() => sell.selectProduct(product)}
                aria-pressed={sell.selectedProduct?.id === product.id}
                className={`group w-full overflow-hidden rounded-xl border text-left transition ${
                  sell.selectedProduct?.id === product.id
                    ? 'border-brand ring-2 ring-brand/40'
                    : 'border-track bg-card hover:border-brand/40 hover:bg-card/80'
                }`}
              >
                <div className="flex aspect-[3/4] items-center justify-center bg-track">
                  <CardImage src={product.imageSourceUrl} alt={product.name} />
                </div>
                <div className="space-y-0.5 p-2 text-xs">
                  <p className="truncate font-semibold text-ink" title={product.name}>
                    {product.name}
                  </p>
                  <p className="truncate text-ink-muted">
                    {[product.setName, product.cardNumber].filter(Boolean).join(' • ') ||
                      'Unknown set'}
                  </p>
                  <p className="pt-1 font-mono text-brand">
                    {formatCentsAsCurrency(
                      product.minSellPriceCents ?? product.maxSellPriceCents ?? 0,
                    )}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {sell.selectedProduct && (
        <SellSkuList
          productName={sell.selectedProduct.name}
          skus={sell.selectedProductSkus}
          loading={sell.loadingProductSkus}
          error={sell.productSkuError}
          addingSkuId={sell.addingSkuId}
          disabled={paid}
          onAdd={(barcode, skuId) => void sell.addSellSku(barcode, skuId)}
        />
      )}
    </ResultGroup>
  );

  const catalogResults = (
    <ResultGroup
      title="Catalog"
      badge={intakeMode === 'trade' ? 'Trade in' : 'Buy'}
      empty={
        trade.searchError ? (
          <p className="mt-2 text-xs text-rose-300">{trade.searchError}</p>
        ) : trade.searchFetching ? (
          <p className="mt-2 text-xs text-ink-muted">Searching catalog…</p>
        ) : query.trim().length >= 2 && trade.searchResults.length === 0 ? (
          <p className="mt-2 text-xs text-ink-muted">No catalog matches.</p>
        ) : null
      }
    >
      {trade.searchResults.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {trade.searchResults.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                onClick={() => trade.selectQueuedSearchCard(card)}
                aria-pressed={trade.selectedCard?.id === card.id}
                className={`w-full overflow-hidden rounded-xl border text-left transition ${
                  trade.selectedCard?.id === card.id
                    ? 'border-brand ring-2 ring-brand/40'
                    : 'border-track bg-card hover:border-brand/40 hover:bg-card/80'
                }`}
              >
                <div className="aspect-[3/4] w-full">
                  <CardImage src={card.imageUrl} alt={card.name} />
                </div>
                <div className="space-y-0.5 p-2 text-xs">
                  <p className="truncate font-semibold text-ink" title={card.name}>
                    {card.name}
                  </p>
                  <p className="truncate text-ink-muted">
                    {[card.setName, card.number ? `#${card.number}` : null]
                      .filter(Boolean)
                      .join(' • ') || 'Unknown set'}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </ResultGroup>
  );

  return (
    <>
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          <div className="rounded-2xl border border-track bg-card/60 p-4 shadow-sm">
            <TransactionEntryBar
              label="Search inventory & catalog"
              value={query}
              onChange={handleQueryChange}
              autoFocus
              placeholder='Card name or number (e.g. "Charizard" or "025/189")'
              scan={{
                active: true,
                confirmLabel: intakeMode === 'trade' ? 'Add to trade' : 'Add to buy',
                allowAddToInventory: true,
                onConfirm: (card: CatalogCard) => trade.selectQueuedSearchCard(card),
                onAdded: () =>
                  void queryClient.invalidateQueries({
                    queryKey: ['transactions', 'sell', 'search'],
                  }),
              }}
            >
              {/* Catalog filters — only affect the catalog side of the search. */}
              <div className="mt-3 flex flex-wrap gap-2">
                <div className="min-w-0 flex-1 basis-full sm:basis-[calc(50%-0.25rem)] lg:basis-[calc(25%-0.375rem)]">
                  <SearchableSelect
                    value={trade.language}
                    onChange={trade.handleLanguageChange}
                    placeholder="Language"
                    searchPlaceholder="Search languages"
                    options={trade.languageOptions}
                  />
                </div>
                <div className="min-w-0 flex-1 basis-full sm:basis-[calc(50%-0.25rem)] lg:basis-[calc(25%-0.375rem)]">
                  <SearchableSelect
                    value={trade.setId}
                    onChange={trade.setSetId}
                    placeholder={trade.setsLoading ? 'Loading sets…' : 'Any set'}
                    searchPlaceholder="Search sets"
                    disabled={trade.setsLoading}
                    options={trade.sets.map((set) => ({ value: set.id, label: set.name }))}
                  />
                </div>
                <div className="min-w-0 flex-1 basis-full sm:basis-[calc(50%-0.25rem)] lg:basis-[calc(25%-0.375rem)]">
                  <SearchableSelect
                    value={trade.rarity}
                    onChange={trade.setRarity}
                    placeholder="Any rarity"
                    searchPlaceholder="Search rarities"
                    options={Array.from(
                      new Set([...trade.rarityOptions, trade.rarity].filter(Boolean)),
                    ).map((rarity) => ({ value: rarity, label: rarity }))}
                  />
                </div>
                <div className="min-w-0 flex-1 basis-full sm:basis-[calc(50%-0.25rem)] lg:basis-[calc(25%-0.375rem)]">
                  <input
                    type="text"
                    value={trade.artistFilter}
                    onChange={(event) => trade.setArtistFilter(event.target.value)}
                    placeholder="Artist (e.g. Ken Sugimori)"
                    className="min-h-11 w-full rounded-xl border border-border bg-navy px-3 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/40"
                  />
                </div>
              </div>
            </TransactionEntryBar>

            <div className="mt-4 space-y-5">
              {leadWithInventory ? (
                <>
                  {inventoryResults}
                  {catalogResults}
                </>
              ) : (
                <>
                  {catalogResults}
                  {inventoryResults}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Unified cart */}
        <aside className="lg:col-span-4">
          <div className="sticky top-24 rounded-2xl border border-track bg-card/60 p-4 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Cart</h2>

            {sell.sellError && (
              <p className="mt-2 rounded-lg border border-rose-800 bg-rose-950/40 p-2 text-xs text-rose-200">
                {sell.sellError}
              </p>
            )}
            {trade.tradeSubmitErr && (
              <p className="mt-2 rounded-lg border border-rose-800 bg-rose-950/40 p-2 text-xs text-rose-200">
                {trade.tradeSubmitErr}
              </p>
            )}
            {trade.tradeSubmitMsg && (
              <p className="mt-2 rounded-lg border border-emerald-800 bg-emerald-950/40 p-2 text-xs text-emerald-200">
                {trade.tradeSubmitMsg}
              </p>
            )}

            {sell.lines.length === 0 && trade.queuedItems.length === 0 && (
              <p className="mt-3 text-xs text-ink-dim">
                Search or scan a card, then add it to the sale or the buy/trade queue.
              </p>
            )}

            {sell.lines.length > 0 && (
              <CartSection title="Sale" badge="Sell" badgeClass="bg-emerald-500/15 text-emerald-300">
                {sell.lines.map((line) => (
                  <CartLine
                    key={line.id}
                    name={line.name}
                    detail={`${line.condition} • Qty ${line.qty}`}
                    amountCents={line.unitPriceCents * line.qty}
                  />
                ))}
              </CartSection>
            )}

            {trade.queuedItems.length > 0 && (
              <CartSection
                title={intakeMode === 'trade' ? 'Trade-in' : 'Buy'}
                badge={intakeMode === 'trade' ? 'Trade' : 'Buy'}
                badgeClass="bg-sky-500/15 text-sky-300"
              >
                {trade.queuedItems.map((item) => (
                  <CartLine
                    key={item.id}
                    name={item.name}
                    detail={`${item.condition} • ${item.printing} • Qty ${item.quantity}`}
                    amountCents={item.estimatedUnitValueCents * item.quantity}
                    onRemove={() => trade.removeQueuedItem(item.id)}
                  />
                ))}
              </CartSection>
            )}

            {/* Combined money summary */}
            {(sell.lines.length > 0 || trade.queuedItems.length > 0) && (
              <dl className="mt-4 space-y-1 border-t border-track pt-3 text-sm">
                {sell.lines.length > 0 && (
                  <SummaryRow label="Customer pays" valueCents={customerPaysCents} />
                )}
                {storePaysCents > 0 && (
                  <SummaryRow label="Store pays (cash)" valueCents={-storePaysCents} />
                )}
                {storeCreditCents > 0 && (
                  <SummaryRow label="Store credit issued" valueCents={storeCreditCents} muted />
                )}
                {(sell.lines.length > 0 || storePaysCents > 0) && (
                  <SummaryRow label="Net cash" valueCents={netCashCents} emphasize />
                )}
              </dl>
            )}

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={sell.lines.length === 0 || paid || sell.sellStatus === 'checkout'}
                onClick={() => void sell.checkoutSell()}
                className="min-h-11 w-full rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-navy disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sell.sellStatus === 'checkout'
                  ? 'Completing…'
                  : paid
                    ? 'Sale complete'
                    : 'Complete sale'}
              </button>
              <button
                type="button"
                disabled={trade.queuedItems.length === 0}
                onClick={() => trade.submitTrade()}
                className="min-h-11 w-full rounded-xl border border-border px-4 py-2 text-sm font-semibold text-ink transition hover:border-brand disabled:cursor-not-allowed disabled:opacity-50"
              >
                {intakeMode === 'trade' ? 'Create trade-in' : 'Create buy intake'}
              </button>
              {sell.lines.length > 0 && !paid && (
                <button
                  type="button"
                  onClick={() => void sell.cancelSell()}
                  className="min-h-9 w-full rounded-xl px-4 py-1.5 text-xs font-medium text-ink-muted hover:text-ink"
                >
                  Clear sale
                </button>
              )}
            </div>
          </div>
        </aside>
      </section>

      {/* Catalog line configuration (value, condition, grading) */}
      <TradeDetailDrawer trade={trade} />
    </>
  );
}

function ResultGroup({
  title,
  badge,
  empty,
  children,
}: {
  title: string;
  badge: string;
  empty?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
        <span className="rounded-full bg-track px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
          {badge}
        </span>
      </div>
      {children}
      {empty}
    </div>
  );
}

function CartSection({
  title,
  badge,
  badgeClass,
  children,
}: {
  title: string;
  badge: string;
  badgeClass: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{title}</p>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${badgeClass}`}>
          {badge}
        </span>
      </div>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

function CartLine({
  name,
  detail,
  amountCents,
  onRemove,
}: {
  name: string;
  detail: string;
  amountCents: number;
  onRemove?: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-lg border border-track bg-card px-3 py-2 text-xs">
      <div className="min-w-0">
        <p className="truncate font-medium text-ink" title={name}>
          {name}
        </p>
        <p className="text-ink-muted">{detail}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-ink">{formatCentsAsCurrency(amountCents)}</span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove line"
            className="rounded p-1 text-ink-muted hover:bg-track hover:text-rose-300"
          >
            ✕
          </button>
        )}
      </div>
    </li>
  );
}

function SummaryRow({
  label,
  valueCents,
  emphasize,
  muted,
}: {
  label: string;
  valueCents: number;
  emphasize?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        emphasize ? 'font-semibold text-ink' : muted ? 'text-ink-dim' : 'text-ink-muted'
      }`}
    >
      <dt>{label}</dt>
      <dd className="font-mono">{formatCentsAsCurrency(valueCents)}</dd>
    </div>
  );
}
