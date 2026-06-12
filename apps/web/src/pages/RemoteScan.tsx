import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';

type AddItemResult = {
  line: {
    id: string;
    skuId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    imageUrl?: string | null;
  };
  totals: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  };
};

type CameraStatus = 'idle' | 'starting' | 'scanning' | 'error';

const DEDUPE_WINDOW_MS = 1200;

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function RemoteScanPage() {
  const location = useLocation();
  const orderId = useMemo(
    () => new URLSearchParams(location.search).get('orderId')?.trim() ?? '',
    [location.search],
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const submitInFlightRef = useRef(false);
  const recentScanRef = useRef<{ code: string; at: number } | null>(null);

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<string>('');
  const [scanCount, setScanCount] = useState(0);
  const [lastAdded, setLastAdded] = useState<AddItemResult['line'] | null>(null);
  const [totals, setTotals] = useState<AddItemResult['totals'] | null>(null);
  const [manualBarcode, setManualBarcode] = useState('');

  const canUseCamera =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function';

  const stopScanner = useCallback(() => {
    try {
      controlsRef.current?.stop();
    } catch {
      // Ignore stop errors from stale media tracks.
    }
    controlsRef.current = null;
    setCameraStatus((prev) => (prev === 'error' ? prev : 'idle'));
  }, []);

  const submitBarcode = useCallback(
    async (rawBarcode: string) => {
      const barcode = rawBarcode.trim();
      if (!barcode || !orderId) return;

      const now = Date.now();
      const recent = recentScanRef.current;
      if (recent && recent.code === barcode && now - recent.at < DEDUPE_WINDOW_MS) {
        return;
      }
      recentScanRef.current = { code: barcode, at: now };

      if (submitInFlightRef.current) return;
      submitInFlightRef.current = true;

      setLastScan(barcode);
      setSubmitError(null);

      try {
        const out = await api.post<AddItemResult>(`/orders/${orderId}/items`, { barcode });
        setLastAdded(out.line);
        setTotals(out.totals);
        setScanCount((n) => n + 1);
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate?.(35);
        }
      } catch (error) {
        setSubmitError(toErrorMessage(error));
      } finally {
        submitInFlightRef.current = false;
      }
    },
    [orderId],
  );

  const startScanner = useCallback(async () => {
    if (!orderId) return;
    if (!canUseCamera) {
      setCameraStatus('error');
      setCameraError('Camera access is not available on this browser/device.');
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    stopScanner();
    setCameraError(null);
    setCameraStatus('starting');

    if (!readerRef.current) {
      readerRef.current = new BrowserMultiFormatReader();
    }

    try {
      const controls = await readerRef.current.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
          },
        },
        video,
        (result, _error) => {
          if (!result) return;
          void submitBarcode(result.getText());
        },
      );

      controlsRef.current = controls;
      setCameraStatus('scanning');
    } catch (error) {
      setCameraStatus('error');
      setCameraError(toErrorMessage(error));
    }
  }, [canUseCamera, orderId, stopScanner, submitBarcode]);

  useEffect(() => {
    if (!orderId) return;
    void startScanner();
    return () => {
      stopScanner();
    };
  }, [orderId, startScanner, stopScanner]);

  const onManualSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const code = manualBarcode.trim();
      if (!code) return;
      void submitBarcode(code);
      setManualBarcode('');
    },
    [manualBarcode, submitBarcode],
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">Remote Barcode Scanner</h1>
          <p className="text-sm text-slate-400">
            Point your phone camera at a card barcode/QR label to add it directly to this register cart.
          </p>
          {orderId ? (
            <p className="text-xs text-slate-500 break-all">Order: {orderId}</p>
          ) : (
            <p className="text-xs text-rose-300">
              Missing order id. Open this page using the QR code from Register.
            </p>
          )}
        </header>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-3 space-y-3">
          <div className="overflow-hidden rounded-lg border border-slate-700 bg-black">
            <video
              ref={videoRef}
              className="block h-[320px] w-full object-cover"
              muted
              playsInline
              autoPlay
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void startScanner()}
              disabled={!orderId || cameraStatus === 'starting' || cameraStatus === 'scanning'}
            >
              {cameraStatus === 'starting' ? 'Starting camera...' : 'Start camera'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={stopScanner}
              disabled={cameraStatus !== 'scanning'}
            >
              Stop camera
            </button>
          </div>

          <p className="text-xs text-slate-400">
            Status:{' '}
            {cameraStatus === 'scanning'
              ? 'Scanning'
              : cameraStatus === 'starting'
                ? 'Starting'
                : cameraStatus === 'error'
                  ? 'Camera error'
                  : 'Idle'}
          </p>

          {cameraError && <p className="text-xs text-rose-300">{cameraError}</p>}
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-3 space-y-3">
          <h2 className="text-sm font-semibold">Manual barcode entry</h2>
          <form onSubmit={onManualSubmit} className="flex gap-2">
            <input
              value={manualBarcode}
              onChange={(e) => setManualBarcode(e.target.value)}
              placeholder="Paste or type barcode"
              className="input flex-1"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="btn" disabled={!orderId || !manualBarcode.trim()}>
              Add
            </button>
          </form>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-3 space-y-2 text-sm">
          <h2 className="text-sm font-semibold">Scan activity</h2>
          <p className="text-slate-300">Successful scans: {scanCount}</p>
          {lastScan && <p className="text-slate-400 break-all">Last barcode: {lastScan}</p>}
          {submitError && <p className="text-rose-300">{submitError}</p>}

          {lastAdded && (
            <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3 text-emerald-200">
              <div className="font-semibold">Added: {lastAdded.name}</div>
              <div className="text-xs mt-1">Qty: {lastAdded.quantity}</div>
              <div className="text-xs">Unit: {formatMoney(lastAdded.unitPriceCents)}</div>
            </div>
          )}

          {totals && (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded border border-slate-700 p-2">
                <div className="text-slate-400">Subtotal</div>
                <div className="font-semibold">{formatMoney(totals.subtotalCents)}</div>
              </div>
              <div className="rounded border border-slate-700 p-2">
                <div className="text-slate-400">Tax</div>
                <div className="font-semibold">{formatMoney(totals.taxCents)}</div>
              </div>
              <div className="rounded border border-slate-700 p-2">
                <div className="text-slate-400">Total</div>
                <div className="font-semibold">{formatMoney(totals.totalCents)}</div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
