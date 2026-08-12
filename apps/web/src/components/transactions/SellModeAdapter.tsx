import { useState } from 'react';
import { formatCentsAsCurrency } from '../../lib/format';
import { SellCartSidebar, SellMobileActionBar, SellRemoteScanPanel, SellSearchStatus, SellSkuList } from './SellModeAdapterParts';
import { useSellTransaction } from '../../hooks/transactions/useSellTransaction';
import CardImage from './CardImage';

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

  const checkoutStatus = sell['sellStatus'];
  const itemCount = sell.lines.reduce((sum, line) => sum + line.qty, 0);
  const commitDisabled =
    sell.lines.length === 0 || checkoutStatus === 'checkout' || checkoutStatus === 'paid';

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
                      <CardImage src={product.imageSourceUrl} alt={product.name} />
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
                        {formatCentsAsCurrency(product.minSellPriceCents ?? product.maxSellPriceCents ?? 0)}
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
              disabled={checkoutStatus === 'paid'}
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
        checkoutStatus={checkoutStatus}
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
        checkoutStatus={checkoutStatus}
        commitDisabled={commitDisabled}
        onOpenCart={() => setCartOpen(true)}
        onCheckout={() => void sell.checkoutSell()}
      />
    </section>
  );
}
