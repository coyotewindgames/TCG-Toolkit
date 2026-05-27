import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useDebounced } from '../hooks/useBarcodeScanner';

type Product = {
  id: string;
  name: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  imageUrl?: string;
  skus: { id: string; condition: string; printing: string; priceCents: number; qtyOnHand: number }[];
};

export default function InventoryPage() {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 250);
  const { data, isLoading } = useQuery({
    queryKey: ['products', debounced],
    queryFn: () => api.get<Product[]>(`/products?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 1,
  });

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Inventory Search</h1>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, set, or card number…"
        className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-emerald-500"
      />
      {isLoading && <p className="opacity-60 mt-4">Searching…</p>}
      <ul className="mt-4 space-y-2">
        {data?.map((p) => (
          <li key={p.id} className="bg-slate-900 rounded-xl p-3 flex gap-4">
            {p.imageUrl && <img src={p.imageUrl} className="w-16 h-24 rounded object-cover" />}
            <div className="flex-1">
              <div className="font-semibold">
                {p.name} <span className="opacity-50 text-sm">#{p.cardNumber}</span>
              </div>
              <div className="text-sm opacity-70">
                {p.setName} • {p.rarity}
              </div>
              <ul className="mt-2 text-xs grid grid-cols-2 gap-1">
                {p.skus.map((s) => (
                  <li key={s.id} className="flex justify-between bg-slate-800 rounded px-2 py-1">
                    <span>
                      {s.printing} / {s.condition}
                    </span>
                    <span className="font-mono">
                      ${(s.priceCents / 100).toFixed(2)} · qty {s.qtyOnHand}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
