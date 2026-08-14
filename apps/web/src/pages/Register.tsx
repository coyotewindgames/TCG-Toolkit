import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';
import { useProductSearchState } from '../hooks/useProductSearchState';
import { useSession } from '../hooks/useSession';
import type {
  AddOrderItemResponse,
  OrderDetailResponse,
  OrderLineView,
  ProductSearchItem,
  ProductSearchResponse,
  ProductSkusResponse,
} from '@tcg/shared';
import { api } from '../lib/api';
import { toBase64UrlJson } from '../lib/encoding';
import { formatCentsAsCurrency } from '../lib/format';
import { getSocket } from '../lib/socket';
import { useInventorySearch } from '../hooks/useInventorySearch';
import { useProductSkus } from '../hooks/useProductSkus';
import RegisterSummaryRow from '../components/RegisterSummaryRow';
import { postWithOutbox, startProcessor, onFlushed, getByOrderId } from '../lib/outbox/processor';

function isLocalOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

export default function RegisterPage() {
  const session = useSession();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [lines, setLines] = useState<OrderLineView[]>([]);
  const [totals, setTotals] = useState<AddOrderItemResponse['totals']>({
    subtotalCents: 0,
    taxCents: 0,
    totalCents: 0,
  });
  const [status, setStatus] = useState<'idle' | 'scanning' | 'checkout' | 'paid'>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [syncingCount, setSyncingCount] = useState(0);
  const [remoteScanQr, setRemoteScanQr] = useState<string | null>(null);
  const {
    query: cardQuery,
    setQuery: setCardQuery,
    isEnabled: isCardSearchEnabled,
    buildParams: buildCardSearchParams,
  } = useProductSearchState({
    debounceMs: 300,
    minQueryLength: 2,
    allowEmptyQuery: false,
    defaultPageSize: 8,
    defaultSort: 'name_asc',
  });
  const [selectedProduct, setSelectedProduct] = useState<ProductSearchItem | null>(null);
  const [addingSkuId, setAddingSkuId] = useState<string | null>(null);

  const cardSearch = useInventorySearch<ProductSearchResponse>({
    scope: 'register',
    query: cardQuery,
    page: 1,
    pageSize: 8,
    sort: 'name_asc',
    enabled: isCardSearchEnabled,
    buildParams: () => buildCardSearchParams({ page: 1, pageSize: 8, sort: 'name_asc' }),
    includeParseDebug: false,
  });
  const cardResults = cardSearch.data?.results ?? [];
  const searchingCards = cardSearch.isFetching;
  const cardSearchError = cardSearch.isError
    ? cardSearch.error instanceof Error
      ? cardSearch.error.message
      : String(cardSearch.error)
    : null;

  const createOrder = useCallback(async () => {
    if (!session.locationId) return null;
    const r = await api.post<{ id: string }>('/orders', {
      locationId: session.locationId,
      ...(session.registerId ? { registerId: session.registerId } : {}),
    });
    setOrderId(r.id);
    return r.id;
  }, [session.locationId, session.registerId]);

  const configuredRemoteBase = import.meta.env.VITE_REMOTE_SCAN_BASE_URL?.trim();
  const browserOrigin = typeof window !== 'undefined' ? window.location.origin : null;
  const remoteScanBase = configuredRemoteBase
    ? configuredRemoteBase.replace(/\/+$/, '')
    : browserOrigin && !isLocalOrigin(browserOrigin)
      ? browserOrigin
      : null;

  const remoteScanUrl =
    orderId && remoteScanBase && session.user && session.accessToken
      ? `${remoteScanBase}/remote-scan?orderId=${encodeURIComponent(orderId)}#h=${encodeURIComponent(
          toBase64UrlJson({
            accessToken: session.accessToken,
            user: session.user,
            locationId: session.locationId,
            registerId: session.registerId,
          }),
        )}`
      : null;

  const refreshOrder = useCallback(async () => {
    if (!orderId) return;
    const data = await api.get<OrderDetailResponse>(`/orders/${orderId}`);
    setTotals({
      subtotalCents: data.order.subtotalCents,
      taxCents: data.order.taxCents,
      totalCents: data.order.totalCents,
    });
    setLines(
      data.items.map((item) => ({
        id: item.id,
        skuId: item.skuId,
        name: item.productNameSnapshot ?? 'Scanned item',
        condition: item.condition,
        unitPriceCents: item.unitPriceCents,
        qty: item.quantity,
        imageUrl: item.imageUrl ?? undefined,
        qtyRemaining: item.qtyRemaining,
      })),
    );
  }, [orderId]);

  useEffect(() => {
    if (!remoteScanUrl) {
      setRemoteScanQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(remoteScanUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    })
      .then((url) => {
        if (!cancelled) setRemoteScanQr(url);
      })
      .catch(() => {
        if (!cancelled) setRemoteScanQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [remoteScanUrl]);

  // Ensure we have an order id
  useEffect(() => {
    if (!session.locationId) return;
    void createOrder().catch((e) => setLastError(String(e)));
  }, [createOrder, session.locationId]);

  // Subscribe to socket events for this register/order
  useEffect(() => {
    if (!orderId) return;
    const s = getSocket();
    s.emit('order.join', { orderId });
    const onItem = (msg: { orderId: string; line: AddOrderItemResponse['line']; totals: AddOrderItemResponse['totals'] }) => {
      if (msg.orderId !== orderId) return;
      void refreshOrder();
    };
    const onRemoved = (msg: { orderId: string }) => {
      if (msg.orderId !== orderId) return;
      void refreshOrder();
    };
    const onCompleted = () => setStatus('paid');
    s.on('cart.itemAdded', onItem);
    s.on('cart.itemRemoved', onRemoved);
    s.on('order.completed', onCompleted);
    return () => {
      s.off('cart.itemAdded', onItem);
      s.off('cart.itemRemoved', onRemoved);
      s.off('order.completed', onCompleted);
    };
  }, [orderId, refreshOrder]);

  // Poll order state as a fallback when socket delivery is delayed/missed.
  useEffect(() => {
    if (!orderId) return;
    void refreshOrder().catch(() => undefined);
    const id = window.setInterval(() => {
      void refreshOrder().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(id);
  }, [orderId, refreshOrder]);

  // Start outbox processor and refresh on flush.
  useEffect(() => {
    startProcessor();
    const unsub = onFlushed(() => {
      if (orderId) void refreshOrder().catch(() => undefined);
    });
    return unsub;
  }, [orderId, refreshOrder]);

  // Track syncing items from outbox.
  const updateSyncingCount = useCallback(async () => {
    if (!orderId) { setSyncingCount(0); return; }
    const entries = await getByOrderId(orderId);
    setSyncingCount(entries.filter((e) => e.status !== 'failed').length);
  }, [orderId]);

  useEffect(() => {
    void updateSyncingCount();
  }, [updateSyncingCount, lines]);

  useBarcodeScanner(async (barcode) => {
    if (!orderId || status === 'paid') return;
    setStatus('scanning');
    try {
      const clientRequestId = crypto.randomUUID();
      const result = await postWithOutbox<AddOrderItemResponse>({
        orderId,
        barcode,
        clientRequestId,
      });
      if (result) {
        await refreshOrder();
      } else {
        // Queued offline — update syncing indicator.
        void updateSyncingCount();
      }
      setLastError(null);
    } catch (e) {
      setLastError(String(e));
    } finally {
      setStatus('idle');
    }
  });

  const subtotal = totals.subtotalCents;
  const taxCents = totals.taxCents;
  const total = totals.totalCents;

  const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

  async function checkout() {
    if (!orderId) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setLastError('You\u2019re offline \u2014 reconnect to continue.');
      return;
    }
    setStatus('checkout');
    try {
      await api.post(`/orders/${orderId}/record-sale`, {});
      setStatus('paid');
      setLastError(null);
    } catch (e) {
      setLastError(String(e));
      setStatus('idle');
    }
  }

  async function cancelTransaction() {
    if (!orderId || status === 'paid') return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setLastError('You\u2019re offline \u2014 reconnect to continue.');
      return;
    }
    setStatus('checkout');
    try {
      await api.post(`/orders/${orderId}/cancel`, {});
      setLastError(null);
      setLines([]);
      setTotals({ subtotalCents: 0, taxCents: 0, totalCents: 0 });
      setCardQuery('');
      setSelectedProduct(null);
      setOrderId(null);
      await createOrder();
    } catch (e) {
      setLastError(String(e));
      setStatus('idle');
    } finally {
      setStatus('idle');
    }
  }

  async function loadProductSkus(product: ProductSearchItem) {
    setSelectedProduct(product);
  }

  const selectedProductSkusQuery = useProductSkus<ProductSkusResponse>(selectedProduct?.id, {
    enabled: !!selectedProduct,
    scope: 'register',
  });
  const selectedProductSkus = selectedProductSkusQuery.data?.skus ?? [];
  const loadingProductSkus = selectedProductSkusQuery.isLoading;
  const productSkuError = selectedProductSkusQuery.error
    ? selectedProductSkusQuery.error instanceof Error
      ? selectedProductSkusQuery.error.message
      : String(selectedProductSkusQuery.error)
    : null;

  async function addSkuToOrder(sku: ProductSkusResponse['skus'][number]) {
    if (!orderId || status === 'paid') return;
    setAddingSkuId(sku.id);
    try {
      const clientRequestId = crypto.randomUUID();
      const result = await postWithOutbox<AddOrderItemResponse>({
        orderId,
        barcode: sku.barcode,
        clientRequestId,
      });
      if (result) {
        await refreshOrder();
      } else {
        void updateSyncingCount();
      }
      setLastError(null);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingSkuId(null);
    }
  }

  return (
    <div className="grid grid-cols-12 gap-4 p-4 min-h-screen">
      <section className="col-span-8 bg-card rounded-2xl p-4">
        <header className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold">Register</h1>
          <div className="text-sm opacity-70">Scan a label to add a card</div>
        </header>
        {remoteScanUrl && (
          <div className="mb-3 rounded-lg border border-track bg-navy p-4">
            <p className="text-xs text-ink-muted mb-2">Scan this QR on your phone/scanner device:</p>
            <div className="flex items-start justify-center">
              <div className="w-48 h-48 md:w-56 md:h-56 rounded bg-white p-2 shrink-0 flex items-center justify-center">
                {remoteScanQr ? (
                  <img
                    src={remoteScanQr}
                    alt="QR code for remote scanner"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <span className="text-[10px] text-ink-dim">QR unavailable</span>
                )}
              </div>
            </div>
          </div>
        )}
        {!remoteScanUrl && orderId && (
          <div className="mb-3 rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200">
            Remote scan QR is disabled on localhost. Set VITE_REMOTE_SCAN_BASE_URL to a phone-
            reachable URL (for example your deployed web URL or LAN IP host).
          </div>
        )}
        <div className="mb-3 rounded-lg border border-track bg-navy p-3 space-y-2">
          <p className="text-xs text-ink-muted">Search card name and add to cart without scanning</p>
          <input
            value={cardQuery}
            onChange={(e) => {
              setCardQuery(e.target.value);
              setSelectedProduct(null);
            }}
            placeholder="Search by card name..."
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand"
          />
          {searchingCards && <p className="text-xs text-ink-muted">Searching cards...</p>}
          {cardSearchError && <p className="text-xs text-rose-300">{cardSearchError}</p>}
          {!searchingCards && cardQuery.trim().length >= 2 && cardResults.length === 0 && !cardSearchError && (
            <p className="text-xs text-ink-muted">No matching cards found.</p>
          )}

          {cardResults.length > 0 && (
            <ul className="max-h-56 overflow-auto grid grid-cols-2 gap-2 rounded-md border border-track p-2 sm:grid-cols-3">
              {cardResults.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => void loadProductSkus(p)}
                    className="w-full overflow-hidden rounded-xl border border-track bg-card text-left transition hover:border-brand/60 hover:bg-card/80"
                  >
                    <div className="h-24 bg-track flex items-center justify-center sm:h-28">
                      {p.imageSourceUrl ? (
                        <img
                          src={p.imageSourceUrl}
                          alt={p.name}
                          className="h-full w-full object-contain p-1"
                          loading="lazy"
                        />
                      ) : (
                        <span className="text-xs text-ink-dim">No image</span>
                      )}
                    </div>
                    <div className="space-y-1 p-2">
                      <div className="text-xs font-semibold leading-tight">{p.name}</div>
                      <div className="text-xs text-ink-muted">
                        {[p.setName, p.cardNumber].filter(Boolean).join(' • ') || 'Unknown set'}
                      </div>
                      <div className="text-sm font-black tracking-tight text-brand">
                        {formatCentsAsCurrency(p.minSellPriceCents ?? p.maxSellPriceCents ?? 0)}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selectedProduct && (
            <div className="rounded-md border border-track bg-card/60 p-2 space-y-2">
              <p className="text-xs text-ink-muted">SKUs for {selectedProduct.name}</p>
              {loadingProductSkus && <p className="text-xs text-ink-muted">Loading SKUs...</p>}
              {productSkuError && <p className="text-xs text-rose-300">{productSkuError}</p>}
              {!loadingProductSkus && !productSkuError && selectedProductSkus.length === 0 && (
                <p className="text-xs text-ink-muted">No SKUs available for this card.</p>
              )}
              {selectedProductSkus.map((sku) => (
                <div key={sku.id} className="flex items-center justify-between gap-2 rounded border border-track bg-navy px-2 py-1">
                  <div className="text-xs text-ink-muted">
                    {sku.condition} • {sku.printing} • {sku.language} • Qty {sku.availableQty}
                    {typeof sku.sellPriceCents === 'number'
                      ? ` • ${formatCentsAsCurrency(sku.sellPriceCents)}`
                      : ''}
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={sku.availableQty <= 0 || !!addingSkuId || status === 'paid'}
                    onClick={() => void addSkuToOrder(sku)}
                  >
                    {addingSkuId === sku.id ? 'Adding...' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <ul className="divide-y divide-track">
          {lines.length === 0 && syncingCount === 0 && <li className="py-8 text-center opacity-60">No items yet — scan to begin.</li>}
          {syncingCount > 0 && (
            <li className="py-3 text-center text-sm text-amber-300">
              Syncing… {syncingCount} {syncingCount === 1 ? 'item' : 'items'} pending
            </li>
          )}
          {lines.map((l) => (
            <li key={l.skuId} className="flex items-center gap-4 py-3">
              {l.imageUrl ? (
                <img
                  src={l.imageUrl}
                  alt={l.name}
                  className="w-20 h-28 rounded-lg border border-border object-contain bg-track p-1 shrink-0"
                />
              ) : (
                <div className="w-20 h-28 rounded-lg border border-dashed border-border bg-track/50 shrink-0" />
              )}
              <div className="flex-1 min-w-0 flex flex-col justify-between self-stretch py-1">
                <div>
                  <div className="font-semibold text-sm leading-tight">{l.name}</div>
                  <div className="text-xs opacity-70 mt-1">
                    {l.condition}
                    {typeof l.qtyRemaining === 'number' ? ` • ${l.qtyRemaining} remaining` : ''}
                  </div>
                </div>
                <div className="mt-2 text-xl md:text-2xl font-black tracking-tight text-brand">
                  {formatCentsAsCurrency(l.unitPriceCents * l.qty)}
                </div>
              </div>
              <div className="text-sm w-14 text-right self-center opacity-80">×{l.qty}</div>
            </li>
          ))}
        </ul>
      </section>
      <aside className="col-span-4 bg-card rounded-2xl p-4 flex flex-col">
        <h2 className="text-lg font-semibold mb-4">Totals</h2>
        <RegisterSummaryRow label="Subtotal" value={formatCentsAsCurrency(subtotal)} />
        <RegisterSummaryRow label="Tax" value={formatCentsAsCurrency(taxCents)} />
        <div className="border-t border-track my-2" />
        <RegisterSummaryRow label="Total" value={formatCentsAsCurrency(total)} large />
        <div className="mt-auto grid grid-cols-2 gap-3">
          <button
            disabled={lines.length === 0 || status === 'checkout' || status === 'paid'}
            onClick={cancelTransaction}
            className="bg-rose-600 hover:bg-rose-500 disabled:bg-track text-white font-bold rounded-xl py-4 text-lg"
          >
            {status === 'checkout' ? 'Cancelling…' : 'Cancel'}
          </button>
          <button
            disabled={lines.length === 0 || status === 'checkout' || status === 'paid'}
            onClick={checkout}
            className="bg-brand hover:bg-brand-dark disabled:bg-track text-navy font-bold rounded-xl py-4 text-lg"
          >
            {status === 'checkout' ? 'Recording…' : status === 'paid' ? 'Sale recorded ✓' : 'Record Sale'}
          </button>
        </div>
        {lastError && <p className="text-rose-400 text-xs mt-3 break-all">{lastError}</p>}
      </aside>
    </div>
  );
}
