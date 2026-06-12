import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useDebounced } from '../hooks/useBarcodeScanner';
import { useSession } from '../hooks/useSession';
import SidePanel, { PanelSection } from '../components/SidePanel';
import ImageBackfillPanel from '../components/ImageBackfillPanel';

type Product = {
  id: string;
  name: string;
  setName: string | null;
  cardNumber: string | null;
  rarity: string | null;
  imageSourceUrl?: string | null;
  minSellPriceCents: number | null;
  maxSellPriceCents: number | null;
};

type ProductSearchResponse = { results: Product[] };
type ProductSku = {
  id: string;
  barcode: string;
  condition: string;
  printing: string;
  language: string;
  sellPriceCents: number | null;
};
type ProductSkusResponse = { skus: ProductSku[] };
type InventorySummary = {
  estimatedCostCents: number;
  qtyOnHand: number;
  skuCount: number;
};

function QrImage({ skuId, label }: { skuId: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setSrc(null);
    setError(null);

    void api
      .getBlob(`/skus/${skuId}/barcode.png?format=qr`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [skuId]);

  if (error) {
    return <p className="text-rose-300 text-xs">{error}</p>;
  }

  if (!src) {
    return <div className="w-full max-w-xl h-20 rounded-md bg-slate-800 animate-pulse" />;
  }

  return (
    <img
      src={src}
      alt={label}
      className="w-full max-w-xl h-20 object-contain bg-white rounded-md p-2"
      loading="lazy"
    />
  );
}

interface ImportResult {
  totalRows: number;
  productsCreated: number;
  skusCreated: number;
  inventoryCreated: number;
  inventoryUpdated: number;
  costsApplied: number;
  pricesSeeded: number;
  marketPricesApplied: number;
  errors: Array<{ row: number; message: string }>;
  dryRun: boolean;
}

type ImportProgressState =
  | { phase: 'idle'; loaded: number; total: number | null; percent: number }
  | { phase: 'uploading'; loaded: number; total: number | null; percent: number }
  | { phase: 'processing'; loaded: number; total: number | null; percent: number };

export default function InventoryPage() {
  const [q, setQ] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [barcodeProduct, setBarcodeProduct] = useState<Product | null>(null);
  const [printingKey, setPrintingKey] = useState<string | null>(null);
  const [printErr, setPrintErr] = useState<string | null>(null);
  const debounced = useDebounced(q, 250);
  const { data, isLoading } = useQuery({
    queryKey: ['products', debounced],
    queryFn: () =>
      api.get<ProductSearchResponse>(`/products/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 1,
  });
  const summaryQuery = useQuery({
    queryKey: ['inventory-summary'],
    queryFn: () => api.get<InventorySummary>('/inventory/summary'),
  });
  const skuQuery = useQuery({
    queryKey: ['product-skus', barcodeProduct?.id],
    queryFn: () => api.get<ProductSkusResponse>(`/products/${barcodeProduct!.id}/skus`),
    enabled: !!barcodeProduct,
  });
  const expandedSkuQuery = useQuery({
    queryKey: ['product-skus', expandedProductId],
    queryFn: () => api.get<ProductSkusResponse>(`/products/${expandedProductId!}/skus`),
    enabled: !!expandedProductId,
  });

  useEffect(() => {
    if (!expandedProductId) return;
    const stillVisible = data?.results.some((p) => p.id === expandedProductId) ?? false;
    if (!stillVisible) {
      setExpandedProductId(null);
    }
  }, [data?.results, expandedProductId]);

  async function printLabels(items: Array<{ skuId: string; copies?: number }>, fileStem: string) {
    setPrintErr(null);
    const blob = await api.postBlob('/skus/labels.pdf', { format: 'qr', items });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileStem.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48)}-labels.pdf`;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function onPrintOne(sku: ProductSku) {
    try {
      setPrintingKey(`one:${sku.id}`);
      await printLabels([{ skuId: sku.id, copies: 1 }], barcodeProduct?.name ?? 'barcode');
    } catch (e) {
      setPrintErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPrintingKey(null);
    }
  }

  async function onPrintAll() {
    if (!skuQuery.data?.skus?.length) return;
    try {
      setPrintingKey('all');
      await printLabels(
        skuQuery.data.skus.map((s) => ({ skuId: s.id, copies: 1 })),
        barcodeProduct?.name ?? 'barcode',
      );
    } catch (e) {
      setPrintErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPrintingKey(null);
    }
  }

  async function onPrintAllVisible() {
    const visibleProducts = data?.results ?? [];
    if (visibleProducts.length === 0) return;

    try {
      setPrintingKey('page-all');
      const skuGroups = await Promise.all(
        visibleProducts.map((product) => api.get<ProductSkusResponse>(`/products/${product.id}/skus`)),
      );
      const items = skuGroups.flatMap((group) =>
        group.skus.map((sku) => ({ skuId: sku.id, copies: 1 })),
      );
      if (items.length === 0) {
        throw new Error('No SKUs found in the current search results.');
      }
      if (items.length > 500) {
        throw new Error('Current search results exceed the 500-label print limit. Narrow the search first.');
      }
      await printLabels(items, debounced || 'inventory');
    } catch (e) {
      setPrintErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPrintingKey(null);
    }
  }

  function renderPriceSummary(product: Product) {
    if (product.minSellPriceCents == null && product.maxSellPriceCents == null) {
      return 'No price yet';
    }
    const min = product.minSellPriceCents ?? product.maxSellPriceCents;
    const max = product.maxSellPriceCents ?? product.minSellPriceCents;
    if (min == null || max == null) {
      return 'No price yet';
    }
    if (min === max) {
      return `$${(min / 100).toFixed(2)}`;
    }
    return `$${(min / 100).toFixed(2)} - $${(max / 100).toFixed(2)}`;
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-sm text-slate-400">Search products, import CSVs, and backfill images.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            className="btn"
            onClick={() => void onPrintAllVisible()}
            disabled={printingKey === 'page-all' || isLoading || (data?.results.length ?? 0) === 0}
          >
            {printingKey === 'page-all' ? 'Printing all…' : 'Print all visible'}
          </button>
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-2"
            onClick={() => setToolsOpen(true)}
            aria-expanded={toolsOpen}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            Tools
          </button>
        </div>
      </header>

      <section>
        <div className="mb-4 rounded-2xl border border-emerald-900/50 bg-emerald-950/20 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-emerald-300/80">
            Total estimated inventory cost
          </div>
          <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
            <div>
              {summaryQuery.isLoading ? (
                <p className="text-2xl font-semibold text-emerald-100">Loading…</p>
              ) : summaryQuery.isError ? (
                <p className="text-sm text-rose-300">Could not load inventory summary.</p>
              ) : (
                <p className="text-2xl font-semibold text-emerald-100">
                  ${(summaryQuery.data!.estimatedCostCents / 100).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </p>
              )}
            </div>
            {!summaryQuery.isLoading && !summaryQuery.isError && summaryQuery.data && (
              <div className="text-sm text-emerald-200/80">
                {summaryQuery.data.qtyOnHand.toLocaleString()} items on hand across{' '}
                {summaryQuery.data.skuCount.toLocaleString()} inventory rows
              </div>
            )}
          </div>
        </div>

        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, set, or card number…"
          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-emerald-500"
        />
        {isLoading && <p className="opacity-60 mt-4">Searching…</p>}
        {printErr && <p className="text-rose-300 text-sm mt-4">{printErr}</p>}
        {!isLoading && debounced.length > 1 && (data?.results.length ?? 0) === 0 && (
          <p className="opacity-60 mt-4">No results.</p>
        )}
        <ul className="mt-4 space-y-2">
          {data?.results.map((p) => (
            <li key={p.id} className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <button
                type="button"
                className="w-full p-3 flex gap-4 text-left hover:bg-slate-900/80"
                onClick={() => setExpandedProductId((current) => (current === p.id ? null : p.id))}
                aria-expanded={expandedProductId === p.id}
              >
                {p.imageSourceUrl ? (
                  <img
                    src={p.imageSourceUrl}
                    alt={p.name}
                    className="w-16 h-24 rounded object-cover bg-slate-800"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-16 h-24 rounded bg-slate-800 border border-dashed border-slate-700" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-base leading-tight">{p.name}</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-300">
                        <span className="rounded-full border border-slate-700 px-2 py-1 bg-slate-950/80">
                          Set: {p.setName || 'Unknown set'}
                        </span>
                        <span className="rounded-full border border-slate-700 px-2 py-1 bg-slate-950/80">
                          Card #: {p.cardNumber || 'N/A'}
                        </span>
                        <span className="rounded-full border border-emerald-700/60 px-2 py-1 bg-emerald-950/40 text-emerald-200">
                          Price: {renderPriceSummary(p)}
                        </span>
                        {p.rarity && (
                          <span className="rounded-full border border-slate-700 px-2 py-1 bg-slate-950/80">
                            {p.rarity}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-slate-400 shrink-0 pt-1">
                      {expandedProductId === p.id ? 'Hide details' : 'Show details'}
                    </span>
                  </div>
                </div>
              </button>

              {expandedProductId === p.id && (
                <div className="border-t border-slate-800 bg-slate-950/50 px-4 py-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span>Product ID: {p.id}</span>
                    <span>•</span>
                    <span>Set: {p.setName || 'Unknown set'}</span>
                    <span>•</span>
                    <span>Card #: {p.cardNumber || 'N/A'}</span>
                    <span>•</span>
                    <span>Price: {renderPriceSummary(p)}</span>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setBarcodeProduct(p)}
                    >
                      View barcodes
                    </button>
                  </div>

                  {expandedSkuQuery.isLoading && (
                    <p className="text-sm text-slate-400">Loading item details…</p>
                  )}
                  {expandedSkuQuery.error && (
                    <p className="text-sm text-rose-300">{String(expandedSkuQuery.error)}</p>
                  )}
                  {!expandedSkuQuery.isLoading && !expandedSkuQuery.error && (
                    <div className="space-y-2">
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        SKU details ({expandedSkuQuery.data?.skus.length ?? 0})
                      </p>
                      {(expandedSkuQuery.data?.skus.length ?? 0) === 0 ? (
                        <p className="text-sm text-slate-400">No SKUs found for this product yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {(expandedSkuQuery.data?.skus ?? []).map((sku) => (
                            <div
                              key={sku.id}
                              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2"
                            >
                              <div className="flex flex-wrap gap-2 text-sm text-slate-200">
                                <span>{sku.condition}</span>
                                <span>• {sku.printing}</span>
                                <span>• {sku.language}</span>
                                {typeof sku.sellPriceCents === 'number' && (
                                  <span>• ${(sku.sellPriceCents / 100).toFixed(2)}</span>
                                )}
                              </div>
                              <p className="mt-1 text-xs text-slate-400 break-all">
                                Barcode: {sku.barcode}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {barcodeProduct && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close barcode popup"
            className="absolute inset-0 bg-black/70"
            onClick={() => setBarcodeProduct(null)}
          />
          <div className="absolute inset-x-4 top-8 bottom-8 md:inset-x-12 md:top-12 md:bottom-12 bg-slate-900 border border-slate-700 rounded-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <div>
                <h2 className="text-lg font-semibold">Barcodes</h2>
                <p className="text-sm text-slate-400">{barcodeProduct.name}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={onPrintAll}
                  disabled={printingKey === 'all' || (skuQuery.data?.skus.length ?? 0) === 0}
                >
                  {printingKey === 'all' ? 'Printing all…' : 'Print all labels'}
                </button>
                <button type="button" className="btn" onClick={() => setBarcodeProduct(null)}>
                  Close
                </button>
              </div>
            </div>

            <div className="p-4 overflow-auto space-y-3">
              {skuQuery.isLoading && <p className="text-slate-400">Loading barcodes…</p>}
              {skuQuery.error && (
                <p className="text-rose-300 text-sm">{String(skuQuery.error)}</p>
              )}
              {printErr && <p className="text-rose-300 text-sm">{printErr}</p>}
              {!skuQuery.isLoading && (skuQuery.data?.skus.length ?? 0) === 0 && (
                <p className="text-slate-400">No SKUs found for this product yet.</p>
              )}

              {(skuQuery.data?.skus ?? []).map((sku) => (
                <article
                  key={sku.id}
                  className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2"
                >
                  <div className="text-sm text-slate-300 flex flex-wrap gap-2">
                    <span>{sku.condition}</span>
                    <span>• {sku.printing}</span>
                    <span>• {sku.language}</span>
                    {typeof sku.sellPriceCents === 'number' && (
                      <span>• ${(sku.sellPriceCents / 100).toFixed(2)}</span>
                    )}
                  </div>
                  <QrImage skuId={sku.id} label={`QR code for ${barcodeProduct.name}`} />
                  <p className="font-mono text-xs text-slate-400 break-all">{sku.barcode}</p>
                  <div>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onPrintOne(sku)}
                      disabled={printingKey === `one:${sku.id}` || printingKey === 'all'}
                    >
                      {printingKey === `one:${sku.id}` ? 'Printing…' : 'Print this label'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      )}

      <SidePanel
        open={toolsOpen}
        onClose={() => setToolsOpen(false)}
        title="Inventory tools"
        subtitle="Bulk operations and integrations"
      >
        <PanelSection title="Import CSV/XLSX">
          <CsvImporter />
        </PanelSection>
        <PanelSection title="Backfill product images" defaultOpen={false}>
          <ImageBackfillPanel />
        </PanelSection>
        <PanelSection title="Danger zone" defaultOpen={false}>
          <WipeInventoryPanel />
        </PanelSection>
      </SidePanel>
    </div>
  );
}

function CsvImporter() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filename, setFilename] = useState<string>('');
  const [defaultCondition, setDefaultCondition] = useState<'NM' | 'LP' | 'MP' | 'HP' | 'DMG'>(
    'NM',
  );
  const [defaultPrinting, setDefaultPrinting] = useState<
    'Normal' | 'Foil' | 'Reverse' | 'Holo' | 'FirstEdition'
  >('Normal');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgressState>({
    phase: 'idle',
    loaded: 0,
    total: null,
    percent: 0,
  });

  const locationId = useSession().locationId;

  const submit = useMutation({
    mutationFn: (dryRun: boolean) => {
      if (!file) throw new Error('Choose a CSV/XLSX file first.');
      if (!locationId) throw new Error('No location selected.');

      setImportProgress({
        phase: 'uploading',
        loaded: 0,
        total: file.size,
        percent: 0,
      });

      const form = new FormData();
      form.append('file', file, file.name);
      form.append('locationId', locationId);
      form.append('defaultCondition', defaultCondition);
      form.append('defaultPrinting', defaultPrinting);
      form.append('dryRun', String(dryRun));

      return api.postForm<ImportResult>('/inventory/import/file', form, {
        onUploadProgress: (progress) => {
          const percent = progress.percent ?? 0;
          setImportProgress({
            phase: percent >= 100 ? 'processing' : 'uploading',
            loaded: progress.loaded,
            total: progress.total,
            percent,
          });
        },
      });
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      if (!data.dryRun) {
        qc.invalidateQueries({ queryKey: ['products'] });
        qc.invalidateQueries({ queryKey: ['inventory'] });
        qc.invalidateQueries({ queryKey: ['inventory-summary'] });
        qc.invalidateQueries({ queryKey: ['product-skus'] });
      }
    },
    onError: (e: unknown) => {
      setError(String(e));
      setResult(null);
    },
    onSettled: () => {
      setImportProgress({
        phase: 'idle',
        loaded: 0,
        total: null,
        percent: 0,
      });
    },
  });

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFilename(f.name);
    setFile(f);
    setResult(null);
    setError(null);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Collectr / TCGplayer / Deckbox / generic CSVs (CSV format only - XLSX not supported)
      </p>

      <p className="text-sm text-slate-400">
        Recognised columns (case-insensitive, any subset):{' '}
        <code className="text-slate-300">
          Name, Set, Set Code, Card Number, Game, Variant/Foil, Condition, Language, Quantity,
          Purchase Price/Cost, Market Price
        </code>
        . Whatever the file says wins; defaults below are only used when a row's Condition or
        Printing cell is empty. Re-importing the same file is safe — quantities add to existing
        rows.
      </p>

      <div className="flex flex-col gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          className="text-sm"
        />
        <label className="text-sm">
          <span className="block text-slate-300 mb-1">Default condition (when missing)</span>
          <select
            className="input"
            value={defaultCondition}
            onChange={(e) => setDefaultCondition(e.target.value as typeof defaultCondition)}
          >
            {(['NM', 'LP', 'MP', 'HP', 'DMG'] as const).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-slate-300 mb-1">Default printing (when missing)</span>
          <select
            className="input"
            value={defaultPrinting}
            onChange={(e) => setDefaultPrinting(e.target.value as typeof defaultPrinting)}
          >
            {(['Normal', 'Foil', 'Reverse', 'Holo', 'FirstEdition'] as const).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>

      {filename && (
        <p className="text-xs text-slate-400">
          Loaded: <span className="text-slate-200">{filename}</span> ({((file?.size ?? 0) / (1024 * 1024)).toFixed(2)} MB)
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          className="btn"
          onClick={() => submit.mutate(true)}
          disabled={!file || !locationId || submit.isPending}
        >
          {submit.isPending && submit.variables === true ? 'Previewing…' : 'Preview (dry run)'}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => submit.mutate(false)}
          disabled={!file || !locationId || submit.isPending}
        >
          {submit.isPending && submit.variables === false ? 'Importing…' : 'Import'}
        </button>
      </div>

      {submit.isPending && (
        <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2">
          <p className="text-xs text-slate-300">
            {importProgress.phase === 'uploading'
              ? `Uploading file... ${importProgress.percent}%`
              : 'Upload complete. Processing import...'}
          </p>

          {importProgress.phase === 'uploading' ? (
            <progress className="w-full" value={importProgress.percent} max={100} />
          ) : (
            <progress className="w-full" />
          )}

          {importProgress.phase === 'uploading' && importProgress.total ? (
            <p className="text-[11px] text-slate-400">
              {(importProgress.loaded / (1024 * 1024)).toFixed(2)} MB /{' '}
              {(importProgress.total / (1024 * 1024)).toFixed(2)} MB
            </p>
          ) : null}
        </div>
      )}

      {!locationId && (
        <p className="text-xs text-rose-300 mt-2">
          No location selected. Pick one from the location switcher first.
        </p>
      )}

      {error && <p className="text-rose-300 text-sm mt-3">{error}</p>}

      {result && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          {!result.dryRun && (
            <p className="col-span-full text-emerald-300 text-xs">
              Import complete. Processed {result.totalRows.toLocaleString()} row
              {result.totalRows === 1 ? '' : 's'} with{' '}
              {(result.totalRows - result.errors.length).toLocaleString()} successful row
              {result.totalRows - result.errors.length === 1 ? '' : 's'}.
            </p>
          )}
          <Stat label="Rows" value={result.totalRows} />
          <Stat label="Products created" value={result.productsCreated} />
          <Stat label="SKUs created" value={result.skusCreated} />
          <Stat label="Inventory rows created" value={result.inventoryCreated} />
          <Stat label="Inventory rows updated" value={result.inventoryUpdated} />
          <Stat label="Costs applied" value={result.costsApplied} />
          <Stat label="Market prices imported" value={result.marketPricesApplied} />
          <Stat label="Prices seeded" value={result.pricesSeeded} />
          {result.dryRun && (
            <p className="col-span-full text-amber-300 text-xs">
              Dry run — nothing was committed. Click Import to apply.
            </p>
          )}
          {!result.dryRun && result.productsCreated > 0 && (
            <p className="col-span-full text-sky-300 text-xs">
              New products were imported. Use Backfill product images below to pull images, and
              configured stores will continue image enrichment in the background.
            </p>
          )}
          {result.errors.length > 0 && (
            <details className="col-span-full mt-2">
              <summary className="cursor-pointer text-rose-300">
                {result.errors.length} row{result.errors.length === 1 ? '' : 's'} failed
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-slate-300 max-h-60 overflow-auto">
                {result.errors.slice(0, 100).map((er) => (
                  <li key={er.row}>
                    Row {er.row}: {er.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}

/**
 * Destructive "wipe all inventory" control. Server requires the typed phrase
 * "DELETE ALL INVENTORY" as a dead-man's switch, so we mirror that prompt
 * here rather than a simple confirm() to make replays / muscle-memory clicks
 * impossible. Only nukes quantity-on-hand rows; products & SKUs stay so a
 * re-import is fast.
 */
const WIPE_PHRASE = 'DELETE ALL INVENTORY';

function WipeInventoryPanel() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState<{ deleted: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wipe = useMutation({
    mutationFn: () =>
      api.post<{ deleted: number; locations: number }>('/inventory/wipe', {
        confirm: WIPE_PHRASE,
      }),
    onSuccess: (data) => {
      setDone({ deleted: data.deleted });
      setError(null);
      setConfirm('');
      // Anything that displays inventory counts is now stale.
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-summary'] });
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setDone(null);
    },
  });

  const armed = confirm === WIPE_PHRASE;

  return (
    <div className="space-y-3 border border-rose-900/50 bg-rose-950/20 rounded-lg p-3">
      <div>
        <h3 className="text-sm font-semibold text-rose-300">Wipe all inventory</h3>
        <p className="text-xs text-slate-400 mt-1">
          Zeroes out every on-hand row across every location in this store. The product
          catalog and any sales / trade-in history are preserved, so re-importing a CSV
          will restore quantities without re-creating SKUs. There is no undo.
        </p>
      </div>

      <label className="block text-xs">
        <span className="block text-slate-300 mb-1">
          Type <code className="text-rose-300">{WIPE_PHRASE}</code> to enable the button.
        </span>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-rose-500 font-mono text-sm"
          placeholder={WIPE_PHRASE}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <button
        type="button"
        onClick={() => wipe.mutate()}
        disabled={!armed || wipe.isPending}
        className="w-full bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 disabled:text-slate-400 text-white font-semibold rounded-lg py-2 transition"
      >
        {wipe.isPending ? 'Wiping…' : 'Wipe all inventory'}
      </button>

      {error && <p className="text-xs text-rose-300">{error}</p>}
      {done && (
        <p className="text-xs text-emerald-300">
          Deleted {done.deleted.toLocaleString()} inventory row{done.deleted === 1 ? '' : 's'}.
        </p>
      )}
    </div>
  );
}
