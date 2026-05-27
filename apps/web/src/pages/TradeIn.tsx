import { useState } from 'react';
import { api } from '../lib/api';

type ScanResponse = {
  skuId: string;
  name: string;
  condition: 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';
  printing: 'Normal' | 'Foil' | 'Reverse' | 'Holo' | 'FirstEdition';
  language: 'EN' | 'JP' | 'DE' | 'FR' | 'IT' | 'ES' | 'PT' | 'KO' | 'CN';
  priceCents: number;
};

type Line = ScanResponse & { quantity: number };

export default function TradeInPage() {
  const [items, setItems] = useState<Line[]>([]);
  const [barcode, setBarcode] = useState('');
  const [payout, setPayout] = useState<'cash' | 'store_credit'>('store_credit');
  const [status, setStatus] = useState<string | null>(null);

  async function addLine() {
    if (!barcode) return;
    try {
      const r = await api.post<ScanResponse>('/scans', { barcode });
      setItems((p) => [...p, { ...r, quantity: 1 }]);
      setBarcode('');
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function submit() {
    try {
      const r = await api.post<{ id: string; status: string; totalValueCents: number }>(
        '/tradeins',
        {
          locationId: import.meta.env.VITE_LOCATION_ID,
          payout,
          items: items.map((i) => ({
            skuId: i.skuId,
            condition: i.condition,
            printing: i.printing,
            language: i.language,
            quantity: i.quantity,
          })),
        },
      );
      setStatus(`Trade ${r.id} → ${r.status} ($${(r.totalValueCents / 100).toFixed(2)})`);
      setItems([]);
    } catch (e) {
      setStatus(String(e));
    }
  }

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Trade-In Intake</h1>
      <div className="flex gap-2">
        <input
          autoFocus
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addLine()}
          placeholder="Scan or type barcode…"
          className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3"
        />
        <button onClick={addLine} className="bg-sky-500 px-4 rounded-xl font-semibold text-slate-900">
          Add
        </button>
      </div>

      <div className="mt-4 flex gap-2">
        {(['store_credit', 'cash'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPayout(p)}
            className={`px-4 py-2 rounded-xl text-sm ${payout === p ? 'bg-emerald-500 text-slate-900' : 'bg-slate-800'}`}
          >
            Payout: {p === 'store_credit' ? 'credit' : p}
          </button>
        ))}
      </div>

      <ul className="mt-4 divide-y divide-slate-800">
        {items.map((i, idx) => (
          <li key={`${i.skuId}-${idx}`} className="py-2 flex justify-between">
            <span>
              {i.name} <span className="opacity-60 text-sm">{i.condition}</span>
            </span>
            <span className="font-mono">×{i.quantity}</span>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex justify-end">
        <button
          disabled={items.length === 0}
          onClick={submit}
          className="bg-emerald-500 disabled:bg-slate-700 text-slate-900 font-bold rounded-xl px-6 py-3"
        >
          Submit Trade
        </button>
      </div>
      {status && <p className="mt-4 text-sm opacity-80">{status}</p>}
    </div>
  );
}
