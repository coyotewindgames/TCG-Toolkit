import { useEffect, useState } from 'react';
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
      const line = msg.line;
      setTotals(msg.totals);
      setLines((prev) => {
        const i = prev.findIndex((l) => l.skuId === line.skuId);
        if (i >= 0) {
          const next = prev.slice();
          next[i] = { ...next[i]!, qty: next[i]!.qty + line.quantity };
          return next;
        }
        return [
          ...prev,
          {
            id: line.id,
            skuId: line.skuId,
            name: line.name,
            condition: '',
            unitPriceCents: line.unitPriceCents,
            qty: line.quantity,
            imageUrl: line.imageUrl ?? undefined,
          },
        ];
      });
    };
    const onCompleted = () => setStatus('paid');
    s.on('cart.itemAdded', onItem);
    s.on('order.completed', onCompleted);
    return () => {
      s.off('cart.itemAdded', onItem);
      s.off('order.completed', onCompleted);
    };
  }, [orderId]);

  useBarcodeScanner(async (barcode) => {
    if (!orderId || status === 'paid') return;
    setStatus('scanning');
    try {
      const r = await api.post<AddItemResult>(`/orders/${orderId}/items`, { barcode });
      // optimistic: server will also emit cart.itemAdded via WS
      setTotals(r.totals);
      setLines((prev) => {
        const i = prev.findIndex((l) => l.skuId === r.line.skuId);
        if (i >= 0) {
          const next = prev.slice();
          next[i] = { ...next[i]!, qty: next[i]!.qty + r.line.quantity };
          return next;
        }
        return [
          ...prev,
          {
            id: r.line.id,
            skuId: r.line.skuId,
            name: r.line.name,
            condition: '',
            unitPriceCents: r.line.unitPriceCents,
            qty: r.line.quantity,
            imageUrl: r.line.imageUrl ?? undefined,
          },
        ];
      });
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
      await api.post(`/orders/${orderId}/checkout`, {
        provider: 'clover',
        deviceId: import.meta.env.VITE_CLOVER_DEVICE_ID ?? 'mvp-device',
      });
    } catch (e) {
      setLastError(String(e));
      setStatus('idle');
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
        <ul className="divide-y divide-slate-800">
          {lines.length === 0 && <li className="py-8 text-center opacity-60">No items yet — scan to begin.</li>}
          {lines.map((l) => (
            <li key={l.skuId} className="flex items-center gap-4 py-3">
              {l.imageUrl && <img src={l.imageUrl} alt="" className="w-12 h-16 rounded object-cover" />}
              <div className="flex-1">
                <div className="font-semibold">{l.name}</div>
                <div className="text-xs opacity-70">{l.condition}</div>
              </div>
              <div className="text-sm w-14 text-right">×{l.qty}</div>
              <div className="font-mono w-20 text-right">{formatMoney(l.unitPriceCents * l.qty)}</div>
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
          {status === 'checkout' ? 'Charging…' : status === 'paid' ? 'Paid ✓' : 'Charge Card'}
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
