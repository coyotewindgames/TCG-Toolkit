import { useState } from 'react';
import { centsToMoney } from '../../lib/transactions';
import { useSellTransaction } from '../../hooks/transactions/useSellTransaction';

interface SellModeAdapterProps {
  active: boolean;
}

/**
 * Sell mode UI.
 *
 * Layout:
 *  - Mobile: single column, sticky cart summary chip, full-screen cart drawer
 *  - Desktop: two-column grid, cart lives in a sticky sidebar
 */
export default function SellModeAdapter({ active }: SellModeAdapterProps) {
  const sell = useSellTransaction(active);
  const [cartOpen, setCartOpen] = useState(false);

  if (!active) return null;

  const itemCount = sell.lines.reduce((sum, line) => sum + line.qty, 0);
  const commitDisabled =
    sell.lines.length === 0 || sell.sellStatus === 'checkout' || sell.sellStatus === 'paid';

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      {/* Primary column: search + SKUs */}
      <div className="space-y-4 lg:col-span-8">
        <SellRemoteScanPanel remoteScanUrl={sell.remoteScanUrl} remoteScanQr={sell.remoteScanQr} />

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 shadow-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
              Search inventory
            </span>
            <input
              value={sell.sellQuery}
              onChange={(event) => {
                sell.setSellQuery(event.target.value);
                sell.selectProduct(null);
              }}
              placeholder="Search by card name..."
              className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/40"
            />
          </label>

          <SellSearchStatus
            fetching={sell.searchingCards}
            error={sell.cardSearchError}
            hasQuery={sell.sellQuery.trim().length >= 2}
            resultCount={sell.cardResults.length}
          />

          {sell.cardResults.length > 0 && (
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {sell.cardResults.map((product) => (
                <li key={product.id}>
                  <button
                    type="button"
                    onClick={() => sell.selectProduct(product)}
                    aria-pressed={sell.selectedProduct?.id === product.id}
                    className={`group w-full overflow-hidden rounded-xl border text-left transition ${
                      sell.selectedProduct?.id === product.id
                        ? 'border-emerald-500 ring-2 ring-emerald-500/40'
                        : 'border-slate-800 bg-slate-900 hover:border-emerald-500/40 hover:bg-slate-900/80'
                    }`}
                  >
                    <div className="flex aspect-[3/4] items-center justify-center bg-slate-800">
                      {product.imageSourceUrl ? (
                        <img
                          src={product.imageSourceUrl}
                          alt={product.name}
                          loading="lazy"
                          className="h-full w-full object-contain p-1"
                        />
                      ) : (
                        <span className="text-xs text-slate-500">No image</span>
                      )}
                    </div>
                    <div className="space-y-0.5 p-2 text-xs">
                      <p className="truncate font-semibold text-slate-100" title={product.name}>
                        {product.name}
                      </p>
                      <p className="truncate text-slate-400">
                        {[product.setName, product.cardNumber].filter(Boolean).join(' • ') ||
                          'Unknown set'}
                      </p>
                      <p className="pt-1 font-mono text-emerald-300">
                        {centsToMoney(product.minSellPriceCents ?? product.maxSellPriceCents ?? 0)}
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
              disabled={sell.sellStatus === 'paid'}
              onAdd={(barcode, skuId) => void sell.addSellSku(barcode, skuId)}
            />
          )}
        </div>
      </div>

      {/* Cart sidebar */}
      <SellCartSidebar
        lines={sell.lines}
        totals={sell.totals}
        itemCount={itemCount}
        error={sell.sellError}
        status={sell.sellStatus}
        commitDisabled={commitDisabled}
        onCheckout={() => void sell.checkoutSell()}
        onCancel={() => void sell.cancelSell()}
        openOnMobile={cartOpen}
        onCloseMobile={() => setCartOpen(false)}
      />

      {/* Mobile-only sticky action bar */}
      <SellMobileActionBar
        itemCount={itemCount}
        totalCents={sell.totals.totalCents}
        status={sell.sellStatus}
        commitDisabled={commitDisabled}
        onOpenCart={() => setCartOpen(true)}
        onCheckout={() => void sell.checkoutSell()}
      />
    </section>
  );
}

/** Non-scanning UI status line — one place to render all fetch/empty/error states. */
function SellSearchStatus({
  fetching,
  error,
  hasQuery,
  resultCount,
}: {
  fetching: boolean;
  error: string | null;
  hasQuery: boolean;
  resultCount: number;
}) {
  if (fetching) return <p className="mt-2 text-xs text-slate-400">Searching cards…</p>;
  if (error) return <p className="mt-2 text-xs text-rose-300">{error}</p>;
  if (hasQuery && resultCount === 0)
    return <p className="mt-2 text-xs text-slate-400">No matching cards found.</p>;
  if (!hasQuery)
    return <p className="mt-2 text-xs text-slate-500">Type 2+ characters to search inventory.</p>;
  return null;
}

function SellSkuList({
  productName,
  skus,
  loading,
  error,
  addingSkuId,
  disabled,
  onAdd,
}: {
  productName: string;
  skus: ReturnType<typeof useSellTransaction>['selectedProductSkus'];
  loading: boolean;
  error: string | null;
  addingSkuId: string | null;
  disabled: boolean;
  onAdd: (barcode: string, skuId: string) => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/80 p-3">
      <p className="mb-2 text-xs text-slate-300">
        SKUs for <span className="font-semibold text-slate-100">{productName}</span>
      </p>
      {loading && <p className="text-xs text-slate-400">Loading SKUs…</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {!loading && skus.length === 0 && !error && (
        <p className="text-xs text-slate-500">No SKUs available for this product.</p>
      )}
      <ul className="space-y-1.5">
        {skus.map((sku) => (
          <li
            key={sku.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2"
          >
            <div className="min-w-0 flex-1 text-xs text-slate-300">
              <p className="font-medium text-slate-100">
                {sku.condition} • {sku.printing} • {sku.language}
              </p>
              <p className="text-slate-400">
                Qty {sku.availableQty}
                {typeof sku.sellPriceCents === 'number' ? ` • ${centsToMoney(sku.sellPriceCents)}` : ''}
              </p>
            </div>
            <button
              type="button"
              disabled={sku.availableQty <= 0 || !!addingSkuId || disabled}
              onClick={() => onAdd(sku.barcode, sku.id)}
              className="min-h-9 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-900 transition hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400"
            >
              {addingSkuId === sku.id ? 'Adding…' : 'Add'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SellRemoteScanPanel({
  remoteScanUrl,
  remoteScanQr,
}: {
  remoteScanUrl: string | null;
  remoteScanQr: string | null;
}) {
  if (!remoteScanUrl) {
    return (
      <div className="rounded-2xl border border-amber-800/60 bg-amber-950/30 p-4 text-xs text-amber-200">
        Remote scan QR is disabled on localhost. Set{' '}
        <code className="rounded bg-amber-950/60 px-1 py-0.5 font-mono">VITE_REMOTE_SCAN_BASE_URL</code>{' '}
        to a phone-reachable URL to enable it.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:flex-row sm:items-center">
      <div className="flex h-40 w-40 shrink-0 items-center justify-center rounded-xl bg-white p-2 sm:h-44 sm:w-44">
        {remoteScanQr ? (
          <img
            src={remoteScanQr}
            alt="QR code for remote scanner"
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-[10px] text-slate-500">QR unavailable</span>
        )}
      </div>
      <div className="text-sm text-slate-300">
        <p className="text-sm font-semibold text-slate-100">Remote scanner</p>
        <p className="mt-1 text-xs text-slate-400">
          Scan this QR from a phone or tablet to add SKUs into this order without touching the POS.
        </p>
      </div>
    </div>
  );
}

interface SellCartSidebarProps {
  lines: ReturnType<typeof useSellTransaction>['lines'];
  totals: ReturnType<typeof useSellTransaction>['totals'];
  itemCount: number;
  error: string | null;
  status: ReturnType<typeof useSellTransaction>['sellStatus'];
  commitDisabled: boolean;
  onCheckout: () => void;
  onCancel: () => void;
  openOnMobile: boolean;
  onCloseMobile: () => void;
}

function SellCartSidebar({
  lines,
  totals,
  itemCount,
  error,
  status,
  commitDisabled,
  onCheckout,
  onCancel,
  openOnMobile,
  onCloseMobile,
}: SellCartSidebarProps) {
  return (
    <>
      {/* Mobile drawer backdrop */}
      <div
        onClick={onCloseMobile}
        aria-hidden={!openOnMobile}
        className={`fixed inset-0 z-30 bg-slate-950/60 transition-opacity lg:hidden ${
          openOnMobile ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        aria-label="Current sale"
        className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-slate-800 bg-slate-900 shadow-2xl transition-transform lg:static lg:col-span-4 lg:z-auto lg:max-w-none lg:translate-x-0 lg:rounded-2xl lg:border lg:shadow-none ${
          openOnMobile ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Desktop wrapper is sticky so the cart follows scroll on wide viewports */}
        <div className="flex h-full flex-col lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)]">
          <header className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3 lg:border-b-0 lg:pb-2">
            <h2 className="text-base font-semibold">Current sale</h2>
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close cart"
              className="rounded p-1 text-slate-400 hover:text-slate-100 lg:hidden"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 space-y-2 overflow-y-auto px-4 py-2 text-sm">
            {lines.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/60 p-4 text-center text-xs text-slate-400">
                Scan a barcode or add SKUs — items will show up here.
              </div>
            ) : (
              <ul className="space-y-2">
                {lines.map((line) => (
                  <li
                    key={line.id}
                    className="rounded-xl border border-slate-800 bg-slate-950/70 p-3"
                  >
                    <p className="truncate font-medium text-slate-100" title={line.name}>
                      {line.name}
                    </p>
                    <p className="text-xs text-slate-400">
                      {line.condition}
                      {typeof line.qtyRemaining === 'number' ? ` • ${line.qtyRemaining} remaining` : ''}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="text-slate-300">
                        {line.qty} × {centsToMoney(line.unitPriceCents)}
                      </span>
                      <span className="font-mono text-emerald-300">
                        {centsToMoney(line.qty * line.unitPriceCents)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="mt-2 break-all text-xs text-rose-300">{error}</p>}
          </div>

          <footer className="space-y-3 border-t border-slate-800 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Total
                </p>
                <p className="text-xl font-semibold">{centsToMoney(totals.totalCents)}</p>
              </div>
              <p className="text-right text-xs text-slate-400">
                {itemCount} item{itemCount === 1 ? '' : 's'}
                <br />
                Tax {centsToMoney(totals.taxCents)}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={commitDisabled}
                className="min-h-11 rounded-lg border border-rose-700/60 bg-rose-950/50 px-4 text-sm font-semibold text-rose-200 transition hover:bg-rose-900/60 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onCheckout}
                disabled={commitDisabled}
                className="min-h-11 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400"
              >
                {status === 'checkout'
                  ? 'Recording…'
                  : status === 'paid'
                    ? 'Sale recorded'
                    : 'Complete sale'}
              </button>
            </div>
          </footer>
        </div>
      </aside>
    </>
  );
}

/**
 * Mobile action bar — becomes a "cart chip + primary action" strip on phones.
 * Hidden on lg viewports where the sidebar is always visible.
 */
function SellMobileActionBar({
  itemCount,
  totalCents,
  status,
  commitDisabled,
  onOpenCart,
  onCheckout,
}: {
  itemCount: number;
  totalCents: number;
  status: ReturnType<typeof useSellTransaction>['sellStatus'];
  commitDisabled: boolean;
  onOpenCart: () => void;
  onCheckout: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-950/95 p-3 backdrop-blur supports-[padding:max(0px)]:pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
        <button
          type="button"
          onClick={onOpenCart}
          className="flex min-h-11 flex-1 items-center justify-between rounded-lg border border-slate-700 bg-slate-900 px-3 text-left text-sm"
        >
          <span>
            <span className="block text-[10px] uppercase tracking-wide text-slate-400">Cart</span>
            <span className="font-semibold text-slate-100">
              {itemCount} item{itemCount === 1 ? '' : 's'}
            </span>
          </span>
          <span className="font-mono text-emerald-300">{centsToMoney(totalCents)}</span>
        </button>
        <button
          type="button"
          onClick={onCheckout}
          disabled={commitDisabled}
          className="min-h-11 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400"
        >
          {status === 'checkout' ? 'Recording…' : status === 'paid' ? 'Sale recorded' : 'Complete'}
        </button>
      </div>
    </div>
  );
}
