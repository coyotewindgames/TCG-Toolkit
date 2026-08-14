import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { postWithOutbox, startProcessor } from '../lib/outbox/processor';
import { formatCentsAsCurrency } from '../lib/format';
import { useCameraScanner } from '../lib/scanning/useCameraScanner';

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


const DEDUPE_WINDOW_MS = 1200;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  return new AudioContextCtor();
}

async function playScanSuccessTone(context: AudioContext | null): Promise<void> {
  if (!context) return;

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    gain.connect(context.destination);

    const first = context.createOscillator();
    first.type = 'sine';
    first.frequency.setValueAtTime(880, now);
    first.connect(gain);
    first.start(now);
    first.stop(now + 0.09);

    const second = context.createOscillator();
    second.type = 'sine';
    second.frequency.setValueAtTime(1175, now + 0.09);
    second.connect(gain);
    second.start(now + 0.09);
    second.stop(now + 0.18);

    second.onended = () => {
      gain.disconnect();
      first.disconnect();
      second.disconnect();
    };
  } catch {
    // Audio feedback is best-effort only.
  }
}

export default function RemoteScanPage() {
  const location = useLocation();
  const orderId = useMemo(
    () => new URLSearchParams(location.search).get('orderId')?.trim() ?? '',
    [location.search],
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const submitInFlightRef = useRef(false);
  const recentScanRef = useRef<{ code: string; at: number } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const successFlashTimerRef = useRef<number | null>(null);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<string>('');
  const [scanCount, setScanCount] = useState(0);
  const [lastAdded, setLastAdded] = useState<AddItemResult['line'] | null>(null);
  const [totals, setTotals] = useState<AddItemResult['totals'] | null>(null);
  const [manualBarcode, setManualBarcode] = useState('');
  const [showSuccessFlash, setShowSuccessFlash] = useState(false);

  const triggerSuccessFlash = useCallback(() => {
    if (successFlashTimerRef.current != null) {
      window.clearTimeout(successFlashTimerRef.current);
    }
    setShowSuccessFlash(true);
    successFlashTimerRef.current = window.setTimeout(() => {
      setShowSuccessFlash(false);
      successFlashTimerRef.current = null;
    }, 280);
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
        const clientRequestId = crypto.randomUUID();
        const out = await postWithOutbox<AddItemResult>({
          orderId,
          barcode,
          clientRequestId,
        });
        if (out) {
          setLastAdded(out.line);
          setTotals(out.totals);
          setScanCount((n) => n + 1);
          triggerSuccessFlash();
          await playScanSuccessTone(audioContextRef.current);
          if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            navigator.vibrate?.(35);
          }
        } else {
          // Queued offline.
          setSubmitError('Syncing… item queued for when you\u2019re back online.');
          setScanCount((n) => n + 1);
        }
      } catch (error) {
        setSubmitError(toErrorMessage(error));
      } finally {
        submitInFlightRef.current = false;
      }
    },
    [orderId, triggerSuccessFlash],
  );

  const { status: cameraStatus, error: cameraError, start: cameraScannerStart, stop: stopScanner, isSupported: cameraSupported } = useCameraScanner(
    (code) => void submitBarcode(code),
  );

  const startScanner = useCallback(async () => {
    if (!orderId) return;
    if (!cameraSupported) return;

    const video = videoRef.current;
    if (!video) return;

    if (!audioContextRef.current) {
      audioContextRef.current = getAudioContext();
    }
    if (audioContextRef.current?.state === 'suspended') {
      try {
        await audioContextRef.current.resume();
      } catch {
        // Ignore resume failures; the scan still works without sound.
      }
    }

    await cameraScannerStart(video);
  }, [orderId, cameraSupported, cameraScannerStart]);

  useEffect(() => {
    startProcessor();
  }, []);

  useEffect(() => {
    return () => {
      if (successFlashTimerRef.current != null) {
        window.clearTimeout(successFlashTimerRef.current);
      }
    };
  }, []);

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
    <div className="min-h-screen bg-navy text-ink p-4 md:p-6">
      <div
        aria-hidden="true"
        className={`pointer-events-none fixed inset-0 z-50 bg-brand-dark/30 transition-opacity duration-200 ease-out ${
          showSuccessFlash ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">Remote Barcode Scanner</h1>
          <p className="text-sm text-ink-muted">
            Point your phone camera at a card barcode/QR label to add it directly to this register cart.
          </p>
          {orderId ? (
            <p className="text-xs text-ink-dim break-all">Order: {orderId}</p>
          ) : (
            <p className="text-xs text-rose-300">
              Missing order id. Open this page using the QR code from Register.
            </p>
          )}
        </header>

        <section className="rounded-xl border border-track bg-card p-3 space-y-3">
          <div className="overflow-hidden rounded-lg border border-border bg-black">
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

          <p className="text-xs text-ink-muted">
            Status:{' '}
            {cameraStatus === 'scanning'
              ? 'Scanning'
              : cameraStatus === 'starting'
                ? 'Starting'
                : cameraStatus === 'error'
                  ? 'Camera error'
                  : 'Idle'}
          </p>

          <p className="text-xs text-ink-dim">
            Tap Start camera to trigger the browser permission prompt on your phone.
          </p>

          {cameraError && <p className="text-xs text-rose-300">{cameraError}</p>}
        </section>

        <section className="rounded-xl border border-track bg-card p-3 space-y-3">
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

        <section className="rounded-xl border border-track bg-card p-3 space-y-2 text-sm">
          <h2 className="text-sm font-semibold">Scan activity</h2>
          <p className="text-ink-muted">Successful scans: {scanCount}</p>
          {lastScan && <p className="text-ink-muted break-all">Last barcode: {lastScan}</p>}
          {submitError && <p className="text-rose-300">{submitError}</p>}

          {lastAdded && (
            <div className="rounded-lg border border-brand/60 bg-brand/30 p-3 text-brand">
              <div className="font-semibold">Added: {lastAdded.name}</div>
              <div className="text-xs mt-1">Qty: {lastAdded.quantity}</div>
              <div className="text-xs">Unit: {formatCentsAsCurrency(lastAdded.unitPriceCents)}</div>
            </div>
          )}

          {totals && (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded border border-border p-2">
                <div className="text-ink-muted">Subtotal</div>
                <div className="font-semibold">{formatCentsAsCurrency(totals.subtotalCents)}</div>
              </div>
              <div className="rounded border border-border p-2">
                <div className="text-ink-muted">Tax</div>
                <div className="font-semibold">{formatCentsAsCurrency(totals.taxCents)}</div>
              </div>
              <div className="rounded border border-border p-2">
                <div className="text-ink-muted">Total</div>
                <div className="font-semibold">{formatCentsAsCurrency(totals.totalCents)}</div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
