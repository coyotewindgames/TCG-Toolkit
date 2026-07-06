import { Link } from 'react-router-dom';
import { centsToMoney } from '../../lib/transactions';
import { useSellTransaction } from '../../hooks/transactions/useSellTransaction';

interface SellModeAdapterProps {
  active: boolean;
}

export default function SellModeAdapter({ active }: SellModeAdapterProps) {
  const sell = useSellTransaction(active);

  return (
    <section hidden={!active} aria-hidden={!active} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 lg:col-span-8">
          <h2 className="text-lg font-semibold">Sell Checkout</h2>
          <p className="mt-1 text-sm text-slate-300">
            Scan a barcode or search cards, then add a SKU to the current order.
          </p>

          {sell.remoteScanUrl && (
            <div className="mb-3 mt-4 rounded-lg border border-slate-800 bg-slate-950 p-4">
              <p className="mb-2 text-xs text-slate-400">Scan this QR on your phone/scanner device:</p>
              <div className="flex items-start justify-center">
                <div className="flex h-48 w-48 shrink-0 items-center justify-center rounded bg-white p-2 md:h-56 md:w-56">
                  {sell.remoteScanQr ? (
                    <img
                      src={sell.remoteScanQr}
                      alt="QR code for remote scanner"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <span className="text-[10px] text-slate-500">QR unavailable</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {!sell.remoteScanUrl && active && (
            <div className="mb-3 mt-4 rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200">
              Remote scan QR is disabled on localhost. Set VITE_REMOTE_SCAN_BASE_URL to a phone-reachable URL.
            </div>
          )}

          <div className="mb-3 mt-4 space-y-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
            <p className="text-xs text-slate-400">Search card name and add to cart without scanning</p>
            <input
              value={sell.sellQuery}
              onChange={(event) => {
                sell.setSellQuery(event.target.value);
                sell.selectProduct(null);
              }}
              placeholder="Search by card name..."
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
            {sell.searchingCards && <p className="text-xs text-slate-400">Searching cards...</p>}
            {sell.cardSearchError && <p className="text-xs text-rose-300">{sell.cardSearchError}</p>}
            {!sell.searchingCards && sell.sellQuery.trim().length >= 2 && sell.cardResults.length === 0 && !sell.cardSearchError && (
              <p className="text-xs text-slate-400">No matching cards found.</p>
            )}

            {sell.cardResults.length > 0 && (
              <ul className="grid max-h-56 grid-cols-2 gap-2 overflow-auto rounded-md border border-slate-800 p-2 sm:grid-cols-3">
                {sell.cardResults.map((product) => (
                  <li key={product.id}>
                    <button
                      type="button"
                      onClick={() => sell.selectProduct(product)}
                      className="w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-left transition hover:border-emerald-500/60 hover:bg-slate-900/80"
                    >
                      <div className="flex h-24 items-center justify-center bg-slate-800 sm:h-28">
                        {product.imageSourceUrl ? (
                          <img
                            src={product.imageSourceUrl}
                            alt={product.name}
                            className="h-full w-full object-contain p-1"
                            loading="lazy"
                          />
                        ) : (
                          <span className="text-xs text-slate-500">No image</span>
                        )}
                      </div>
                      <div className="space-y-1 p-2 text-xs">
                        <p className="truncate font-semibold" title={product.name}>
                          {product.name}
                        </p>
                        <p className="truncate text-slate-400">
                          {[product.setName, product.cardNumber].filter(Boolean).join(' • ') || 'Unknown set'}
                        </p>
                        <p className="text-emerald-300">
                          {centsToMoney(product.minSellPriceCents ?? product.maxSellPriceCents ?? 0)}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {sell.selectedProduct && (
              <div className="rounded-md border border-slate-800 bg-slate-900/60 p-2">
                <p className="mb-2 text-xs text-slate-300">SKUs for {sell.selectedProduct.name}</p>
                {sell.loadingProductSkus && <p className="text-xs text-slate-400">Loading SKUs...</p>}
                {sell.productSkuError && <p className="text-xs text-rose-300">{sell.productSkuError}</p>}
                <div className="space-y-1">
                  {sell.selectedProductSkus.map((sku) => (
                    <div
                      key={sku.id}
                      className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950 px-2 py-1"
                    >
                      <div className="text-xs text-slate-300">
                        {sku.condition} • {sku.printing} • {sku.language} • Qty {sku.availableQty}
                        {typeof sku.sellPriceCents === 'number' ? ` • ${centsToMoney(sku.sellPriceCents)}` : ''}
                      </div>
                      <button
                        type="button"
                        disabled={sku.availableQty <= 0 || !!sell.addingSkuId || sell.sellStatus === 'paid'}
                        onClick={() => void sell.addSellSku(sku.barcode, sku.id)}
                        className="rounded bg-emerald-500 px-2 py-1 text-xs font-semibold text-slate-900 disabled:bg-slate-700 disabled:text-slate-400"
                      >
                        {sell.addingSkuId === sku.id ? 'Adding...' : 'Add'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </article>

        <aside className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 lg:col-span-4">
          <h2 className="text-lg font-semibold">Current transaction</h2>
          <p className="mt-1 text-sm text-slate-300">Live order lines from `/orders/:id`.</p>

          <ul className="mt-4 space-y-2 text-sm text-slate-200">
            {sell.lines.length === 0 ? (
              <li className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-slate-400">No items yet.</li>
            ) : (
              sell.lines.map((line) => (
                <li key={line.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                  <p className="truncate font-medium" title={line.name}>
                    {line.name}
                  </p>
                  <p className="text-xs text-slate-400">
                    {line.condition}
                    {typeof line.qtyRemaining === 'number' ? ` • ${line.qtyRemaining} remaining` : ''}
                  </p>
                  <p className="mt-1 text-xs text-slate-300">
                    {line.qty} x {centsToMoney(line.unitPriceCents)}
                  </p>
                </li>
              ))
            )}
          </ul>

          {sell.sellError && <p className="mt-3 break-all text-xs text-rose-300">{sell.sellError}</p>}

          <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-xs text-slate-400">Fallback links</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Link to="/register" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800">
                Legacy Register
              </Link>
              <Link to="/inventory" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800">
                Inventory tools
              </Link>
            </div>
          </div>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-700 bg-slate-900/95 p-3 backdrop-blur supports-[padding:max(0px)]:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Total</p>
            <p className="text-lg font-semibold">{centsToMoney(sell.totals.totalCents)}</p>
            <p className="text-xs text-slate-400">
              Subtotal {centsToMoney(sell.totals.subtotalCents)} • Tax {centsToMoney(sell.totals.taxCents)}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void sell.cancelSell()}
              disabled={sell.lines.length === 0 || sell.sellStatus === 'checkout' || sell.sellStatus === 'paid'}
              className="min-h-11 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:bg-slate-700 disabled:text-slate-400"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void sell.checkoutSell()}
              disabled={sell.lines.length === 0 || sell.sellStatus === 'checkout' || sell.sellStatus === 'paid'}
              className="min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400"
            >
              {sell.sellStatus === 'checkout' ? 'Recording...' : sell.sellStatus === 'paid' ? 'Sale recorded' : 'Complete sale'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
