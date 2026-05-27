import { useEffect, useState } from 'react';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';
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

export default function RegisterPage() {
  const [orderId, setOrderId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<'idle' | 'scanning' | 'checkout' | 'paid'>('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  // Ensure we have an order id
  useEffect(() => {
    (async () => {
      const r = await api.post<{ id: string }>('/orders', {
        locationId: import.meta.env.VITE_LOCATION_ID,
        ...(import.meta.env.VITE_REGISTER_ID ? { registerId: import.meta.env.VITE_REGISTER_ID } : {}),
      });
      setOrderId(r.id);
    })().catch((e) => setLastError(String(e)));
  }, []);

  // Subscribe to socket events for this register/order
  useEffect(() => {
    if (!orderId) return;
    const s = getSocket();
    s.emit('order.join', { orderId });
    const onItem = (msg: {
      orderId: string;
      line: {
        id: string;
        skuId: string;
        name: string;
        quantity: number;
        unitPriceCents: number;
        imageUrl: string | null;
      };
      totals: { subtotalCents: number; taxCents: number; totalCents: number };
    }) => {
      const { line } = msg;
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

  const subtotal = lines.reduce((acc, l) => acc + l.unitPriceCents * l.qty, 0);
  const taxCents = Math.round(subtotal * 0.07);
  const total = subtotal + taxCents;

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
        <Row label="Tax (est.)" value={formatMoney(taxCents)} />
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
