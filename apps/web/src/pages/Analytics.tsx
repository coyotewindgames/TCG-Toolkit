import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';

type RangeKey = '7d' | '30d' | '90d';

type SummaryResponse = {
  transactionCount: number;
  totalSalesCents: number;
  averageTransactionCents: number;
  tradeCount: number;
  tradeValueCents: number;
  tradeItemsQty: number;
};

type PriceKpisResponse = {
  avgSellPriceCents: number;
  avgMarketPriceCents: number;
  pricedSkuCount: number;
};

type CardsByGameResponse = {
  points: Array<{
    game: string;
    products: number;
    qtyOnHand: number;
  }>;
};

type SalesSeriesResponse = {
  points: Array<{
    day: string;
    transactions: number;
    totalSalesCents: number;
  }>;
};

type TradeinSeriesResponse = {
  points: Array<{
    day: string;
    tradeCount: number;
    tradeValueCents: number;
    itemsQty: number;
  }>;
};

type TopMoversResponse = {
  data: Array<{
    cardId: string;
    name: string;
    setName: string | null;
    gameName: string | null;
    productType: string | null;
    foilOnly: boolean;
    printing: string | null;
    marketCents: number | null;
    priceChangePercent: number | null;
    imageUrl: string | null;
  }>;
};

const PIE_COLORS = ['#10b981', '#22d3ee', '#60a5fa', '#f59e0b', '#f43f5e', '#a78bfa'];

function formatMoney(cents: number | null | undefined): string {
  return `$${((cents ?? 0) / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function toDateRange(range: RangeKey): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime());
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  from.setDate(from.getDate() - days);
  return { from: from.toISOString(), to: to.toISOString() };
}

function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>('30d');
  const { from, to } = useMemo(() => toDateRange(range), [range]);

  const summary = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => api.get<SummaryResponse>(`/analytics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  });

  const priceKpis = useQuery({
    queryKey: ['analytics', 'price-kpis', range],
    queryFn: () => api.get<PriceKpisResponse>(`/analytics/price-kpis?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  });

  const cardsByGame = useQuery({
    queryKey: ['analytics', 'cards-by-game', range],
    queryFn: () => api.get<CardsByGameResponse>(`/analytics/cards-by-game?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  });

  const salesSeries = useQuery({
    queryKey: ['analytics', 'sales-series', range],
    queryFn: () => api.get<SalesSeriesResponse>(`/analytics/sales-series?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  });

  const tradeinSeries = useQuery({
    queryKey: ['analytics', 'tradein-series', range],
    queryFn: () => api.get<TradeinSeriesResponse>(`/analytics/tradein-series?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  });

  const topGainers = useQuery({
    queryKey: ['analytics', 'top-movers', 'up'],
    queryFn: () => api.get<TopMoversResponse>('/tcgapi/prices/top-movers?direction=up&period=7d&limit=8&type=Cards'),
    retry: false,
  });

  const topLosers = useQuery({
    queryKey: ['analytics', 'top-movers', 'down'],
    queryFn: () => api.get<TopMoversResponse>('/tcgapi/prices/top-movers?direction=down&period=7d&limit=8&type=Cards'),
    retry: false,
  });

  const marketMoversError =
    (topGainers.error instanceof Error ? topGainers.error.message : null) ??
    (topLosers.error instanceof Error ? topLosers.error.message : null);
  const marketMoversMissingConfig =
    typeof marketMoversError === 'string' &&
    (marketMoversError.toLowerCase().includes('not configured') ||
      marketMoversError.toLowerCase().includes('api key'));

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-sm text-slate-400">Sales, trade-ins, card mix, and 7-day market movers.</p>
        </div>
        <label className="text-xs text-slate-300">
          <span className="block mb-1">Range</span>
          <select
            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2"
            value={range}
            onChange={(e) => setRange(e.target.value as RangeKey)}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
        </label>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Recorded sales"
          value={formatMoney(summary.data?.totalSalesCents)}
          loading={summary.isLoading}
        />
        <KpiCard
          label="Transactions"
          value={(summary.data?.transactionCount ?? 0).toLocaleString()}
          loading={summary.isLoading}
        />
        <KpiCard
          label="Avg ticket"
          value={formatMoney(summary.data?.averageTransactionCents)}
          loading={summary.isLoading}
        />
        <KpiCard
          label="Trade-ins"
          value={(summary.data?.tradeCount ?? 0).toLocaleString()}
          loading={summary.isLoading}
        />
        <KpiCard
          label="Trade-in value"
          value={formatMoney(summary.data?.tradeValueCents)}
          loading={summary.isLoading}
        />
        <KpiCard
          label="Avg market price"
          value={formatMoney(priceKpis.data?.avgMarketPriceCents)}
          loading={priceKpis.isLoading}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Panel title="Cards by game (in stock)">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={(cardsByGame.data?.points ?? []).map((p) => ({ name: p.game, value: p.qtyOnHand }))}
                  dataKey="value"
                  nameKey="name"
                  outerRadius={100}
                  label
                >
                  {(cardsByGame.data?.points ?? []).map((point, idx) => (
                    <Cell key={`${point.game}:${idx}`} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Sales trend">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={(salesSeries.data?.points ?? []).map((p) => ({ ...p, label: shortDay(p.day) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="label" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  formatter={(value, name) => {
                    if (name === 'totalSalesCents') return formatMoney(Number(value));
                    return String(value);
                  }}
                />
                <Line type="monotone" dataKey="totalSalesCents" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Trade-in volume trend">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={(tradeinSeries.data?.points ?? []).map((p) => ({ ...p, label: shortDay(p.day) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="label" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip formatter={(value, name) => (name === 'tradeValueCents' ? formatMoney(Number(value)) : String(value))} />
                <Bar dataKey="itemsQty" fill="#60a5fa" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="7-day market movers">
          {topGainers.isError || topLosers.isError ? (
            marketMoversMissingConfig ? (
              <p className="text-sm text-amber-300">
                Market movers unavailable. Configure TCGapi credentials in Settings to enable this panel.
              </p>
            ) : (
              <p className="text-sm text-amber-300">
                Market movers unavailable right now. {marketMoversError ?? 'Please retry in a moment.'}
              </p>
            )
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <MoverList title="Top gainers" rows={topGainers.data?.data ?? []} positive />
              <MoverList title="Top losers" rows={topLosers.data?.data ?? []} positive={false} />
            </div>
          )}
        </Panel>
      </section>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
      <h2 className="text-sm uppercase tracking-wide text-slate-300">{title}</h2>
      {children}
    </article>
  );
}

function KpiCard({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900 p-3">
      <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="mt-2 text-2xl font-black text-emerald-300">{loading ? '…' : value}</p>
    </article>
  );
}

function MoverList({
  title,
  rows,
  positive,
}: {
  title: string;
  rows: TopMoversResponse['data'];
  positive: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
      <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">{title}</p>
      <ul className="space-y-2">
        {rows.length === 0 && <li className="text-xs text-slate-500">No data.</li>}
        {rows.map((row) => (
          <li key={row.cardId} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-slate-200">{row.name}</span>
            <span className={positive ? 'text-emerald-300 font-semibold' : 'text-rose-300 font-semibold'}>
              {typeof row.priceChangePercent === 'number'
                ? `${positive ? '+' : ''}${row.priceChangePercent.toFixed(2)}%`
                : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
