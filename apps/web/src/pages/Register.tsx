import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';
import { useSession } from '../hooks/useSession';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';

type Line = {
  id: string;
  skuId: string;
  name: string;
  condition: string;
  unitPriceCents: number;
  qty: number;
  imageUrl?: string;
  qtyRemaining?: number;
};

type AddItemResult = {
  line: {
    id: string;
    skuId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    imageUrl?: string | null;
  };
  totals: { subtotalCents: number; taxCents: number; totalCents: number };
};

type OrderDetailResult = {
  order: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  };
  items: Array<{
    id: string;
    skuId: string;
    quantity: number;
    unitPriceCents: number;
    productNameSnapshot: string | null;
    condition: string;
    imageUrl: string | null;
    qtyRemaining: number;
  }>;
};

type ProductSearchItem = {
  id: string;
  name: string;
  setName: string | null;
  cardNumber: string | null;
  availableQty: number;
  minSellPriceCents: number | null;
  maxSellPriceCents: number | null;
};

type ProductSearchResult = {
  results: ProductSearchItem[];
};

type ProductSkusResult = {
  skus: Array<{
    id: string;
    barcode: string;
    condition: string;
    printing: string;
    language: string;
    sellPriceCents: number | null;
    availableQty: number;
  }>;
};

function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function toBase64UrlJson(value: unknown): string {
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isLocalOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

export default function RegisterPage() {
  const session = useSession();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [totals, setTotals] = useState<AddItemResult['totals']>({
    subtotalCents: 0,
    taxCents: 0,
    totalCents: 0,
  });
  const [status, setStatus] = useState<'idle' | 'scanning' | 'checkout' | 'paid'>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [remoteScanQr, setRemoteScanQr] = useState<string | null>(null);
  const [cardQuery, setCardQuery] = useState('');
  const [searchingCards, setSearchingCards] = useState(false);
  const [cardSearchError, setCardSearchError] = useState<string | null>(null);
  const [cardResults, setCardResults] = useState<ProductSearchItem[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<ProductSearchItem | null>(null);
  const [selectedProductSkus, setSelectedProductSkus] = useState<ProductSkusResult['skus']>([]);
  const [loadingProductSkus, setLoadingProductSkus] = useState(false);
  const [productSkuError, setProductSkuError] = useState<string | null>(null);
  const [addingSkuId, setAddingSkuId] = useState<string | null>(null);

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
    const data = await api.get<OrderDetailResult>(`/orders/${orderId}`);
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

  useEffect(() => {
    const trimmed = cardQuery.trim();
    if (trimmed.length < 2) {
      setCardResults([]);
      setSearchingCards(false);
      setCardSearchError(null);
      return;
    }

    let cancelled = false;
    setSearchingCards(true);
    setCardSearchError(null);
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({
        q: trimmed,
        page: '1',
        pageSize: '8',
        sort: 'name_asc',
      });
      void api
        .get<ProductSearchResult>(`/products/search?${params.toString()}`)
        .then((data) => {
          if (cancelled) return;
          setCardResults(data.results ?? []);
        })
        .catch((err) => {
          if (cancelled) return;
          setCardSearchError(err instanceof Error ? err.message : String(err));
          setCardResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearchingCards(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [cardQuery]);

  // Ensure we have an order id
  useEffect(() => {
    if (!session.locationId) return;
    (async () => {
      const r = await api.post<{ id: string }>('/orders', {
        locationId: session.locationId,
        ...(session.registerId ? { registerId: session.registerId } : {}),
      });
      setOrderId(r.id);
    })().catch((e) => setLastError(String(e)));
  }, [session.locationId, session.registerId]);

  // Subscribe to socket events for this register/order
  useEffect(() => {
    if (!orderId) return;
    const s = getSocket();
    s.emit('order.join', { orderId });
    const onItem = (msg: { orderId: string; line: AddItemResult['line']; totals: AddItemResult['totals'] }) => {
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

  useBarcodeScanner(async (barcode) => {
    if (!orderId || status === 'paid') return;
    setStatus('scanning');
    try {
      await api.post<AddItemResult>(`/orders/${orderId}/items`, { barcode });
      await refreshOrder();
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

  async function checkout() {
    if (!orderId) return;
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

  async function loadProductSkus(product: ProductSearchItem) {
    setSelectedProduct(product);
    setLoadingProductSkus(true);
    setProductSkuError(null);
    setSelectedProductSkus([]);
    try {
      const data = await api.get<ProductSkusResult>(`/products/${product.id}/skus`);
      setSelectedProductSkus(data.skus ?? []);
    } catch (err) {
      setProductSkuError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingProductSkus(false);
    }
  }

  async function addSkuToOrder(sku: ProductSkusResult['skus'][number]) {
    if (!orderId || status === 'paid') return;
    setAddingSkuId(sku.id);
    try {
      await api.post<AddItemResult>(`/orders/${orderId}/items`, { barcode: sku.barcode });
      await refreshOrder();
      setLastError(null);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingSkuId(null);
    }
  }

  return (
    <div className="grid grid-cols-12 gap-4 p-4 min-h-screen">
      <section className="col-span-8 bg-slate-900 rounded-2xl p-4">
        <header className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold">Register</h1>
          <div className="text-sm opacity-70">Scan a label to add a card</div>
        </header>
        {remoteScanUrl && (
          <div className="mb-3 rounded-lg border border-slate-800 bg-slate-950 p-4">
            <p className="text-xs text-slate-400 mb-2">Scan this QR on your phone/scanner device:</p>
            <div className="flex items-start justify-center">
              <div className="w-48 h-48 md:w-56 md:h-56 rounded bg-white p-2 shrink-0 flex items-center justify-center">
                {remoteScanQr ? (
                  <img
                    src={remoteScanQr}
                    alt="QR code for remote scanner"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <span className="text-[10px] text-slate-500">QR unavailable</span>
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
        <div className="mb-3 rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2">
          <p className="text-xs text-slate-400">Search card name and add to cart without scanning</p>
          <input
            value={cardQuery}
            onChange={(e) => {
              setCardQuery(e.target.value);
              setSelectedProduct(null);
              setSelectedProductSkus([]);
              setProductSkuError(null);
            }}
            placeholder="Search by card name..."
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          {searchingCards && <p className="text-xs text-slate-400">Searching cards...</p>}
          {cardSearchError && <p className="text-xs text-rose-300">{cardSearchError}</p>}
          {!searchingCards && cardQuery.trim().length >= 2 && cardResults.length === 0 && !cardSearchError && (
            <p className="text-xs text-slate-400">No matching cards found.</p>
          )}

          {cardResults.length > 0 && (
            <ul className="max-h-56 overflow-auto divide-y divide-slate-800 rounded-md border border-slate-800">
              {cardResults.map((p) => (
                <li key={p.id} className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => void loadProductSkus(p)}
                    className="w-full text-left hover:text-emerald-300"
                  >
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="text-xs text-slate-400">
                      {[p.setName, p.cardNumber].filter(Boolean).join(' • ') || 'Unknown set'}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selectedProduct && (
            <div className="rounded-md border border-slate-800 bg-slate-900/60 p-2 space-y-2">
              <p className="text-xs text-slate-300">SKUs for {selectedProduct.name}</p>
              {loadingProductSkus && <p className="text-xs text-slate-400">Loading SKUs...</p>}
              {productSkuError && <p className="text-xs text-rose-300">{productSkuError}</p>}
              {!loadingProductSkus && !productSkuError && selectedProductSkus.length === 0 && (
                <p className="text-xs text-slate-400">No SKUs available for this card.</p>
              )}
              {selectedProductSkus.map((sku) => (
                <div key={sku.id} className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950 px-2 py-1">
                  <div className="text-xs text-slate-300">
                    {sku.condition} • {sku.printing} • {sku.language} • Qty {sku.availableQty}
                    {typeof sku.sellPriceCents === 'number'
                      ? ` • ${formatMoney(sku.sellPriceCents)}`
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
        <ul className="divide-y divide-slate-800">
          {lines.length === 0 && <li className="py-8 text-center opacity-60">No items yet — scan to begin.</li>}
          {lines.map((l) => (
            <li key={l.skuId} className="flex items-center gap-6 py-5">
              {l.imageUrl ? (
                <img
                  src={l.imageUrl}
                  alt={l.name}
                  className="w-40 h-56 rounded-xl border border-slate-700 object-contain bg-slate-800 p-2 shrink-0 shadow-lg shadow-black/20"
                />
              ) : (
                <div className="w-40 h-56 rounded-xl border border-dashed border-slate-700 bg-slate-800/50 shrink-0 shadow-lg shadow-black/20" />
              )}
              <div className="flex-1 min-w-0 flex flex-col justify-between self-stretch py-1">
                <div>
                  <div className="font-semibold text-base leading-tight">{l.name}</div>
                  <div className="text-xs opacity-70 mt-1">
                    {l.condition}
                    {typeof l.qtyRemaining === 'number' ? ` • ${l.qtyRemaining} remaining` : ''}
                  </div>
                </div>
                <div className="mt-4 text-3xl md:text-4xl font-black tracking-tight text-emerald-300">
                  {formatMoney(l.unitPriceCents * l.qty)}
                </div>
              </div>
              <div className="text-sm w-14 text-right self-center opacity-80">×{l.qty}</div>
            </li>
          ))}
        </ul>
      </section>
      <aside className="col-span-4 bg-slate-900 rounded-2xl p-4 flex flex-col">
        <h2 className="text-lg font-semibold mb-4">Totals</h2>
        <Row label="Subtotal" value={formatMoney(subtotal)} />
        <Row label="Tax" value={formatMoney(taxCents)} />
        <div className="border-t border-slate-800 my-2" />
        <Row label="Total" value={formatMoney(total)} large />
        <button
          disabled={lines.length === 0 || status === 'checkout' || status === 'paid'}
          onClick={checkout}
          className="mt-auto bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 text-slate-900 font-bold rounded-xl py-4 text-lg"
        >
          {status === 'checkout' ? 'Recording…' : status === 'paid' ? 'Sale recorded ✓' : 'Record Sale'}
        </button>
        {lastError && <p className="text-rose-400 text-xs mt-3 break-all">{lastError}</p>}
      </aside>
    </div>
  );
}

function Row({ label, value, large }: { label: string; value: string; large?: boolean }) {
  return (
    <div className={`flex justify-between ${large ? 'text-2xl font-bold' : 'text-sm'} py-1`}>
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
