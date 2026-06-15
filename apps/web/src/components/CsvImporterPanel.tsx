/**
 * Reusable CSV/XLSX importer panel.
 * Used in both the Inventory tools side-panel and the onboarding wizard.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../hooks/useSession';

export interface ImportResult {
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

interface Props {
  /** Called with the full result after a successful (non-dry-run) import. */
  onImportSuccess?: (result: ImportResult) => void;
  /** When true, hides the dry-run preview button. */
  hideDryRun?: boolean;
}

export default function CsvImporterPanel({ onImportSuccess, hideDryRun }: Props) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filename, setFilename] = useState('');
  const [dragging, setDragging] = useState(false);
  const [defaultCondition, setDefaultCondition] = useState<'NM' | 'LP' | 'MP' | 'HP' | 'DMG'>('NM');
  const [defaultPrinting, setDefaultPrinting] = useState<'Normal' | 'Foil' | 'Reverse' | 'Holo' | 'FirstEdition'>('Normal');
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
      if (!file) throw new Error('Choose a CSV file first.');
      if (!locationId) throw new Error('No location selected.');

      setImportProgress({ phase: 'uploading', loaded: 0, total: file.size, percent: 0 });

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
        onImportSuccess?.(data);
      }
    },
    onError: (e: unknown) => {
      setError(String(e));
      setResult(null);
    },
    onSettled: () => {
      setImportProgress({ phase: 'idle', loaded: 0, total: null, percent: 0 });
    },
  });

  function pickFile(f: File) {
    setFilename(f.name);
    setFile(f);
    setResult(null);
    setError(null);
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) pickFile(f);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) pickFile(f);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Collectr / TCGplayer / Deckbox / generic CSV or XLSX exports
      </p>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 cursor-pointer transition-colors ${
          dragging
            ? 'border-emerald-400 bg-emerald-500/10'
            : 'border-slate-700 hover:border-slate-500 bg-slate-900/40'
        }`}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {filename ? (
          <p className="text-sm text-slate-200 text-center">
            {filename}{' '}
            <span className="text-slate-500">({((file?.size ?? 0) / (1024 * 1024)).toFixed(2)} MB)</span>
          </p>
        ) : (
          <p className="text-sm text-slate-400 text-center">
            Drop your CSV here or <span className="text-emerald-400">browse</span>
          </p>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,.xls,text/csv"
          onChange={onFileInput}
          className="sr-only"
        />
      </div>

      <div className="flex gap-3">
        <label className="flex-1 text-sm">
          <span className="block text-slate-300 mb-1">Default condition</span>
          <select
            className="input w-full"
            value={defaultCondition}
            onChange={(e) => setDefaultCondition(e.target.value as typeof defaultCondition)}
          >
            {(['NM', 'LP', 'MP', 'HP', 'DMG'] as const).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="flex-1 text-sm">
          <span className="block text-slate-300 mb-1">Default printing</span>
          <select
            className="input w-full"
            value={defaultPrinting}
            onChange={(e) => setDefaultPrinting(e.target.value as typeof defaultPrinting)}
          >
            {(['Normal', 'Foil', 'Reverse', 'Holo', 'FirstEdition'] as const).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>

      {!locationId && (
        <p className="text-xs text-rose-300">No location selected. Pick one first.</p>
      )}

      <div className="flex gap-2">
        {!hideDryRun && (
          <button
            type="button"
            className="btn"
            onClick={() => submit.mutate(true)}
            disabled={!file || !locationId || submit.isPending}
          >
            {submit.isPending && submit.variables === true ? 'Previewing…' : 'Preview (dry run)'}
          </button>
        )}
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
              ? `Uploading… ${importProgress.percent}%`
              : 'Processing import…'}
          </p>
          {importProgress.phase === 'uploading' ? (
            <progress className="w-full" value={importProgress.percent} max={100} />
          ) : (
            <progress className="w-full" />
          )}
        </div>
      )}

      {error && <p className="text-rose-300 text-sm">{error}</p>}

      {result && (
        <div className="space-y-2">
          {!result.dryRun && (
            <p className="text-emerald-300 text-xs">
              ✓ Imported {result.totalRows.toLocaleString()} rows —{' '}
              {(result.totalRows - result.errors.length).toLocaleString()} successful.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Stat label="Products created" value={result.productsCreated} />
            <Stat label="SKUs created" value={result.skusCreated} />
            <Stat label="Inventory rows" value={result.inventoryCreated + result.inventoryUpdated} />
            <Stat label="Prices seeded" value={result.pricesSeeded} />
          </div>
          {result.dryRun && (
            <p className="text-amber-300 text-xs">
              Dry run — nothing committed. Click Import to apply.
            </p>
          )}
          {result.errors.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-rose-300 text-xs">
                {result.errors.length} row{result.errors.length === 1 ? '' : 's'} failed
              </summary>
              <ul className="mt-1 space-y-1 text-xs text-slate-300 max-h-40 overflow-auto">
                {result.errors.slice(0, 50).map((er) => (
                  <li key={er.row}>Row {er.row}: {er.message}</li>
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
