import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CatalogCard, CatalogPricesResponse } from '@tcg/shared';
import CardImage from '../CardImage';
import { api } from '../../../lib/api';
import { queryKeys } from '../../../lib/queryKeys';
import { formatCentsAsCurrency } from '../../../lib/format';
import { useCardPhotoCapture } from '../../../lib/vision/useCardPhotoCapture';
import { useIdentifyCardFromImage } from '../../../hooks/transactions/useIdentifyCardFromImage';

interface CardScanModalProps {
  open: boolean;
  onClose: () => void;
  /** Called when the operator confirms a candidate. The caller wires this into
   * its existing "add to queue" flow (e.g. `trade.selectQueuedSearchCard`). */
  onConfirm: (card: CatalogCard) => void;
  /** Label for the confirm button, e.g. "Add to trade" / "Find in inventory". */
  confirmLabel?: string;
}

type Phase = 'capture' | 'identifying' | 'results';

/**
 * Camera "snap-to-identify" modal for the Buy / Sell / Trade tabs.
 *
 * Steps: capture a photo (live preview on web, OS camera on native) → POST it
 * to the vision identify endpoint → review the extracted identity and the
 * priced catalog candidates → confirm one, which is handed back to the caller.
 * Nothing is mutated here; confirmation is always explicit.
 */
export default function CardScanModal({
  open,
  onClose,
  onConfirm,
  confirmLabel = 'Use this card',
}: CardScanModalProps) {
  const camera = useCardPhotoCapture();
  const identify = useIdentifyCardFromImage();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [phase, setPhase] = useState<Phase>('capture');
  const [captured, setCaptured] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reset all local state and start/stop the camera as the modal toggles.
  useEffect(() => {
    if (!open) {
      camera.stop();
      setPhase('capture');
      setCaptured(null);
      setSelectedId(null);
      identify.reset();
      return;
    }
    // Web: kick off the live preview once the <video> is mounted. Native uses
    // its own camera UI, so there's nothing to start here.
    if (!camera.isNative && videoRef.current) {
      void camera.startPreview(videoRef.current);
    }
    // We intentionally depend only on `open`; camera/identify are stable refs
    // from their hooks and re-running on every render would thrash the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape closes the modal.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function runIdentify(dataUrl: string) {
    setCaptured(dataUrl);
    setPhase('identifying');
    camera.stop();
    try {
      await identify.mutateAsync(dataUrl);
      setPhase('results');
    } catch {
      // Error surfaces via identify.isError below; drop back to results so the
      // operator sees the retake option.
      setPhase('results');
    }
  }

  function handleWebCapture() {
    const dataUrl = camera.captureFromPreview();
    if (dataUrl) void runIdentify(dataUrl);
  }

  async function handleNativeCapture() {
    const dataUrl = await camera.captureNative();
    if (dataUrl) void runIdentify(dataUrl);
  }

  function retake() {
    setCaptured(null);
    setSelectedId(null);
    identify.reset();
    setPhase('capture');
    if (!camera.isNative && videoRef.current) {
      void camera.startPreview(videoRef.current);
    }
  }

  if (!open) return null;

  const data = identify.data;
  const identification = data?.identification ?? null;
  const candidates = data?.candidates ?? [];
  const selectedCard = candidates.find((c) => c.id === selectedId) ?? null;

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-navy/70"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Scan a card with the camera"
        className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-2xl flex-col rounded-t-2xl border border-track bg-card shadow-2xl sm:inset-y-0 sm:my-auto sm:h-[min(92vh,720px)] sm:rounded-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-track px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-brand">
              Camera
            </p>
            <h3 className="text-lg font-semibold">Scan a card</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-ink-muted hover:bg-track hover:text-ink"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {phase === 'capture' && (
            <CaptureView
              camera={camera}
              videoRef={videoRef}
              onWebCapture={handleWebCapture}
              onNativeCapture={handleNativeCapture}
            />
          )}

          {phase === 'identifying' && (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              {captured && (
                <img
                  src={captured}
                  alt="Captured card"
                  className="max-h-52 rounded-lg border border-track object-contain"
                />
              )}
              <p className="text-sm text-ink-muted">Identifying card…</p>
            </div>
          )}

          {phase === 'results' && (
            <ResultsView
              captured={captured}
              identifying={identify.isPending}
              error={identify.isError ? identify.error?.message ?? 'Identification failed.' : null}
              identification={identification}
              pricingConfigured={data?.pricingConfigured ?? false}
              candidates={candidates}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-track px-4 py-3">
          {phase === 'results' ? (
            <>
              <button
                type="button"
                onClick={retake}
                className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-track"
              >
                Retake
              </button>
              <button
                type="button"
                disabled={!selectedCard}
                onClick={() => {
                  if (selectedCard) {
                    onConfirm(selectedCard);
                    onClose();
                  }
                }}
                className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-navy disabled:cursor-not-allowed disabled:opacity-50"
              >
                {confirmLabel}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto rounded-xl border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-track"
            >
              Cancel
            </button>
          )}
        </footer>
      </div>
    </>
  );
}

function CaptureView({
  camera,
  videoRef,
  onWebCapture,
  onNativeCapture,
}: {
  camera: ReturnType<typeof useCardPhotoCapture>;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  onWebCapture: () => void;
  onNativeCapture: () => void;
}) {
  if (!camera.isSupported) {
    return (
      <div className="rounded-lg border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-200">
        This device doesn't support camera capture. Use the search box instead.
      </div>
    );
  }

  if (camera.isNative) {
    return (
      <div className="flex flex-col items-center gap-4 py-10 text-center">
        <p className="text-sm text-ink-muted">
          Point the camera at the card, fill the frame, and capture.
        </p>
        {camera.error && <p className="text-sm text-rose-300">{camera.error}</p>}
        <button
          type="button"
          onClick={onNativeCapture}
          className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-navy"
        >
          Open camera
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-full overflow-hidden rounded-xl border border-track bg-black">
        <video
          ref={videoRef}
          className="block h-[360px] w-full object-cover"
          muted
          playsInline
          autoPlay
        />
        {/* Framing guide sized to a 3:4 card */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[300px] w-[214px] rounded-lg border-2 border-white/70" />
        </div>
      </div>
      {camera.error && <p className="text-sm text-rose-300">{camera.error}</p>}
      <button
        type="button"
        disabled={camera.status !== 'previewing'}
        onClick={onWebCapture}
        className="rounded-full bg-brand px-6 py-3 text-sm font-semibold text-navy disabled:opacity-50"
      >
        {camera.status === 'starting' ? 'Starting camera…' : 'Capture'}
      </button>
    </div>
  );
}

function ResultsView({
  captured,
  identifying,
  error,
  identification,
  pricingConfigured,
  candidates,
  selectedId,
  onSelect,
}: {
  captured: string | null;
  identifying: boolean;
  error: string | null;
  identification: { name: string; setName: string | null; number: string | null; confidence: number } | null;
  pricingConfigured: boolean;
  candidates: CatalogCard[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (identifying) {
    return <p className="py-8 text-center text-sm text-ink-muted">Identifying card…</p>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-200">
        {error} Try retaking the photo with better lighting.
      </div>
    );
  }

  if (!identification) {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        {captured && (
          <img
            src={captured}
            alt="Captured card"
            className="max-h-44 rounded-lg border border-track object-contain"
          />
        )}
        <p className="text-sm text-ink-muted">
          Couldn't read a card in that photo. Retake with the card filling the frame.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        {captured && (
          <img
            src={captured}
            alt="Captured card"
            className="h-24 w-auto rounded-lg border border-track object-contain"
          />
        )}
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-brand">Identified</p>
          <p className="truncate text-base font-semibold" title={identification.name}>
            {identification.name}
          </p>
          <p className="truncate text-xs text-ink-muted">
            {identification.setName ?? 'Unknown set'}
            {identification.number ? ` • #${identification.number}` : ''}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-dim">
            Confidence {Math.round(identification.confidence * 100)}%
          </p>
        </div>
      </div>

      {!pricingConfigured && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-xs text-amber-200">
          PkmnPrices isn't configured, so no catalog matches or pricing are available. Configure it
          in Settings → Integrations.
        </div>
      )}

      {pricingConfigured && candidates.length === 0 && (
        <p className="text-sm text-ink-muted">
          No catalog matches found. Try the search box with the identified name.
        </p>
      )}

      {candidates.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            Pick the matching card
          </p>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {candidates.map((card) => (
              <li key={card.id}>
                <button
                  type="button"
                  onClick={() => onSelect(card.id)}
                  aria-pressed={selectedId === card.id}
                  className={`w-full overflow-hidden rounded-xl border text-left transition ${
                    selectedId === card.id
                      ? 'border-brand ring-2 ring-brand/40'
                      : 'border-track hover:border-border'
                  }`}
                >
                  <div className="aspect-[3/4] w-full">
                    <CardImage src={card.imageUrl} alt={card.name} />
                  </div>
                  <div className="p-2">
                    <p className="truncate text-sm font-semibold" title={card.name}>
                      {card.name}
                    </p>
                    <p className="truncate text-xs text-ink-muted">
                      {card.setName ?? ''}
                      {card.number ? ` • #${card.number}` : ''}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selectedId && <CandidatePrices cardId={selectedId} />}
    </div>
  );
}

/** Live per-printing pricing for the selected candidate, reusing the same
 * `/pkmnprices/cards/:id/prices` endpoint the trade drawer already uses. */
function CandidatePrices({ cardId }: { cardId: string }) {
  const pricesQuery = useQuery<CatalogPricesResponse>({
    queryKey: queryKeys.trade.prices(cardId),
    queryFn: () => api.get<CatalogPricesResponse>(`/pkmnprices/cards/${cardId}/prices`),
    staleTime: 5 * 60_000,
  });

  if (pricesQuery.isPending) {
    return <p className="text-xs text-ink-muted">Loading prices…</p>;
  }
  if (pricesQuery.isError) {
    return <p className="text-xs text-rose-300">Couldn't load prices.</p>;
  }

  const rows = pricesQuery.data?.prices ?? [];
  if (rows.length === 0) {
    return <p className="text-xs text-ink-muted">No pricing available for this card.</p>;
  }

  return (
    <div className="rounded-xl border border-track p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
        Market price by variant
      </p>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.printing} className="flex items-center justify-between text-sm">
            <span className="text-ink-muted">{row.printing}</span>
            <span className="font-mono">{formatCentsAsCurrency(row.marketCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
