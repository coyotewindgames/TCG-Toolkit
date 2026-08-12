import type { OrderLineView, OrderTotals, ProductSkusResponse } from '@tcg/shared';
import { formatCentsAsCurrency } from '../../lib/format';

export type CheckoutStatus = 'idle' | 'scanning' | 'checkout' | 'paid';
export type SellSku = ProductSkusResponse['skus'][number];

export interface SellSearchStatusProps {
  fetching: boolean;
  error: string | null;
  hasQuery: boolean;
  resultCount: number;
}

export function SellSearchStatus({ fetching, error, hasQuery, resultCount }: SellSearchStatusProps) {
  if (fetching) return <p className="mt-2 text-xs text-slate-400">Searching cards…</p>;
  if (error) return <p className="mt-2 text-xs text-rose-300">{error}</p>;
  if (hasQuery && resultCount === 0)
    return <p className="mt-2 text-xs text-slate-400">No matching cards found.</p>;
  if (!hasQuery)
    return <p className="mt-2 text-xs text-slate-500">Type 2+ characters to search inventory.</p>;
  return null;
}

export interface SellSkuListProps {
  productName: string;
  skus: SellSku[];
  loading: boolean;
  error: string | null;
  addingSkuId: string | null;
  disabled: boolean;
  onAdd: (barcode: string, skuId: string) => void;
}

export function SellSkuList({
  productName,
  skus,
  loading,
  error,
  addingSkuId,
  disabled,
  onAdd,
}: SellSkuListProps) {
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
                {typeof sku.sellPriceCents === 'number' ? ` • ${formatCentsAsCurrency(sku.sellPriceCents)}` : ''}
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

export interface SellRemoteScanPanelProps {
  remoteScanUrl: string | null;
  remoteScanQr: string | null;
}

export function SellRemoteScanPanel({ remoteScanUrl, remoteScanQr }: SellRemoteScanPanelProps) {
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

export interface SellCartSidebarProps {
  lines: OrderLineView[];
  totals: OrderTotals;
  itemCount: number;
  error: string | null;
  checkoutStatus: CheckoutStatus;
  commitDisabled: boolean;
  onCheckout: () => void;
  onCancel: () => void;
  openOnMobile: boolean;
  onCloseMobile: () => void;
}

export function SellCartSidebar({
  lines,
  totals,
  itemCount,
  error,
  checkoutStatus,
  commitDisabled,
  onCheckout,
  onCancel,
  openOnMobile,
  onCloseMobile,
}: SellCartSidebarProps) {
  return (
    <>
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
                  <li key={line.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="truncate font-medium text-slate-100" title={line.name}>
                      {line.name}
                    </p>
                    <p className="text-xs text-slate-400">
                      {line.condition}
                      {typeof line.qtyRemaining === 'number' ? ` • ${line.qtyRemaining} remaining` : ''}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="text-slate-300">
                        {line.qty} × {formatCentsAsCurrency(line.unitPriceCents)}
                      </span>
                      <span className="font-mono text-emerald-300">
                        {formatCentsAsCurrency(line.qty * line.unitPriceCents)}
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
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Total</p>
                <p className="text-xl font-semibold">{formatCentsAsCurrency(totals.totalCents)}</p>
              </div>
              <p className="text-right text-xs text-slate-400">
                {itemCount} item{itemCount === 1 ? '' : 's'}
                <br />
                Tax {formatCentsAsCurrency(totals.taxCents)}
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
                {checkoutStatus === 'checkout'
                  ? 'Recording…'
                  : checkoutStatus === 'paid'
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

export interface SellMobileActionBarProps {
  itemCount: number;
  totalCents: number;
  checkoutStatus: CheckoutStatus;
  commitDisabled: boolean;
  onOpenCart: () => void;
  onCheckout: () => void;
}

export function SellMobileActionBar({
  itemCount,
  totalCents,
  checkoutStatus,
  commitDisabled,
  onOpenCart,
  onCheckout,
}: SellMobileActionBarProps) {
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
          <span className="font-mono text-emerald-300">{formatCentsAsCurrency(totalCents)}</span>
        </button>
        <button
          type="button"
          onClick={onCheckout}
          disabled={commitDisabled}
          className="min-h-11 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400"
        >
          {checkoutStatus === 'checkout' ? 'Recording…' : checkoutStatus === 'paid' ? 'Sale recorded' : 'Complete'}
        </button>
      </div>
    </div>
  );
}
