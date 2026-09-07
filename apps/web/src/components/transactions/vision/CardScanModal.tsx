import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CARD_CONDITIONS,
  CARD_PRINTINGS,
  type CardCondition,
  type CardPrinting,
  type CatalogCard,
  type CatalogPricesResponse,
} from '@tcg/shared';
import CardImage from '../CardImage';
import { api } from '../../../lib/api';
import { queryKeys } from '../../../lib/queryKeys';
import { formatCentsAsCurrency } from '../../../lib/format';
import { useSession } from '../../../hooks/useSession';
import { useCardPhotoCapture, useGuideAlignment } from '../../../lib/vision/useCardPhotoCapture';
import { useIdentifyCardFromImage } from '../../../hooks/transactions/useIdentifyCardFromImage';
import { useQuickAddInventory } from '../../../hooks/transactions/useQuickAddInventory';

interface CardScanModalProps {
  open: boolean;
  onClose: () => void;
  /** Called when the operator confirms a candidate. The caller wires this into
   * its existing "add to queue" flow (e.g. `trade.selectQueuedSearchCard`). */
  onConfirm: (card: CatalogCard) => void;
  /** Label for the confirm button, e.g. "Add to trade" / "Find in inventory". */
  confirmLabel?: string;
  /** When true, show an "Add to inventory" action so a scanned card that isn't
   * stocked yet can be created + received on the spot (Sell tab). */
  allowAddToInventory?: boolean;
  /** Called after a successful quick-add so the caller can refresh its list. */
  onAdded?: () => void;
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
  allowAddToInventory = false,
  onAdded,
}: CardScanModalProps) {
  const camera = useCardPhotoCapture();
  const identify = useIdentifyCardFromImage();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const guideRef = useRef<HTMLDivElement | null>(null);

  const [phase, setPhase] = useState<Phase>('capture');
  const [captured, setCaptured] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reset all local state and release the camera when the modal closes.
  useEffect(() => {
    if (open) return;
    camera.stop();
    setPhase('capture');
    setCaptured(null);
    setSelectedId(null);
    identify.reset();
    // Only `open` matters here; camera/identify are stable refs from their hooks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // (Re)start the live preview whenever we're on the capture step. Keying this
  // on `phase` (not just `open`) means it runs AFTER the <video> remounts when
  // returning from results via Retake — fixing the black screen where we
  // previously tried to start the preview before the element existed.
  useEffect(() => {
    if (!open || camera.isNative || phase !== 'capture') return;
    const video = videoRef.current;
    if (!video) return;
    void camera.startPreview(video);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase]);

  // Escape closes the modal.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Auto-select the top candidate as soon as results arrive so the operator
  // sees a price immediately without an extra tap.
  useEffect(() => {
    const candidates = identify.data?.candidates ?? [];
    if (phase === 'results' && selectedId === null && candidates.length > 0) {
      setSelectedId(candidates[0]!.id);
    }
  }, [phase, identify.data, selectedId]);

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
    // Crop to the on-screen framing guide so only the card is sent.
    const dataUrl = camera.captureFromPreview(guideRef.current);
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
    // Flip back to the capture step; the phase-driven effect above restarts the
    // live preview once the <video> remounts.
    setPhase('capture');
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
              guideRef={guideRef}
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
              allowAddToInventory={allowAddToInventory}
              onAdded={() => {
                onAdded?.();
                onClose();
              }}
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
  guideRef,
  onWebCapture,
  onNativeCapture,
}: {
  camera: ReturnType<typeof useCardPhotoCapture>;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  guideRef: React.MutableRefObject<HTMLDivElement | null>;
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
      <WebCaptureView
        camera={camera}
        videoRef={videoRef}
        guideRef={guideRef}
        onWebCapture={onWebCapture}
      />
    </div>
  );
}

/**
 * Live web preview with an alignment-aware framing guide. The guide "lights up"
 * (turns green with a pulsing glow) once the card is well-framed and in focus,
 * nudging the operator to hold steady before capturing.
 */
function WebCaptureView({
  camera,
  videoRef,
  guideRef,
  onWebCapture,
}: {
  camera: ReturnType<typeof useCardPhotoCapture>;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  guideRef: React.MutableRefObject<HTMLDivElement | null>;
  onWebCapture: () => void;
}) {
  const previewing = camera.status === 'previewing';
  const { aligned, score } = useGuideAlignment({
    active: previewing,
    videoRef,
    guideRef,
  });

  return (
    <>
      <div className="relative w-full overflow-hidden rounded-xl border border-track bg-black">
        <video
          ref={videoRef}
          className="block h-[420px] w-full object-cover"
          muted
          playsInline
          autoPlay
        />
        {/* Framing guide sized to a 3:4 card. The capture crops to this box so
            only the card (not the surrounding desk) reaches the model. The
            border + glow animate from neutral → green as alignment improves. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            ref={guideRef}
            className={`h-[360px] w-[257px] rounded-lg border-2 transition-all duration-200 ${
              aligned
                ? 'animate-alignPulse border-emerald-400'
                : 'border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]'
            }`}
          />
        </div>
        {/* Alignment strength bar */}
        {previewing && (
          <div className="pointer-events-none absolute inset-x-0 top-2 mx-auto flex w-40 items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/20">
              <div
                className={`h-full rounded-full transition-all duration-150 ${
                  aligned ? 'bg-emerald-400' : 'bg-white/70'
                }`}
                style={{ width: `${Math.round(score * 100)}%` }}
              />
            </div>
          </div>
        )}
        <p
          className={`pointer-events-none absolute inset-x-0 bottom-2 text-center text-[11px] font-medium transition-colors ${
            aligned ? 'text-emerald-300' : 'text-white/80'
          }`}
        >
          {aligned ? 'Card detected — hold steady' : 'Line the card up inside the frame'}
        </p>
      </div>
      {camera.error && <p className="text-sm text-rose-300">{camera.error}</p>}
      <button
        type="button"
        disabled={!previewing}
        onClick={onWebCapture}
        className={`rounded-full px-6 py-3 text-sm font-semibold text-navy transition disabled:opacity-50 ${
          aligned ? 'animate-glowPulse bg-emerald-400 ring-2 ring-emerald-300/60' : 'bg-brand'
        }`}
      >
        {camera.status === 'starting' ? 'Starting camera…' : 'Capture'}
      </button>
    </>
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
  allowAddToInventory,
  onAdded,
}: {
  captured: string | null;
  identifying: boolean;
  error: string | null;
  identification: { name: string; setName: string | null; number: string | null; confidence: number } | null;
  pricingConfigured: boolean;
  candidates: CatalogCard[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  allowAddToInventory: boolean;
  onAdded: () => void;
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
          No catalog matches found. Try the search box with the identified name
          {allowAddToInventory ? ', or add it to inventory below.' : '.'}
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

      {allowAddToInventory && (
        <AddToInventoryPanel
          card={candidates.find((card) => card.id === selectedId) ?? null}
          fallbackName={identification.name}
          fallbackNumber={identification.number}
          printingHint={null}
          onAdded={onAdded}
        />
      )}
    </div>
  );
}

/**
 * Compact, prefilled form to add the selected (or identified) card straight to
 * inventory as a raw single. The sell price defaults to the card's PkmnPrices
 * market price for the chosen printing; everything stays editable.
 */
function AddToInventoryPanel({
  card,
  fallbackName,
  fallbackNumber,
  printingHint,
  onAdded,
}: {
  card: CatalogCard | null;
  fallbackName: string;
  fallbackNumber: string | null;
  printingHint: string | null;
  onAdded: () => void;
}) {
  const session = useSession();
  const quickAdd = useQuickAddInventory();

  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState<CardCondition>('NM');
  const [printing, setPrinting] = useState<CardPrinting>(
    (CARD_PRINTINGS as readonly string[]).includes(printingHint ?? '')
      ? (printingHint as CardPrinting)
      : 'Normal',
  );
  const [priceDollars, setPriceDollars] = useState('');
  const [priceTouched, setPriceTouched] = useState(false);

  // Pull market prices so we can prefill the sell price from the chosen
  // printing's market value.
  const pricesQuery = useQuery<CatalogPricesResponse>({
    queryKey: queryKeys.trade.prices(card?.id),
    queryFn: () => api.get<CatalogPricesResponse>(`/pkmnprices/cards/${card!.id}/prices`),
    enabled: !!card,
    staleTime: 5 * 60_000,
  });

  const marketCentsForPrinting = useMemo(() => {
    const rows = pricesQuery.data?.prices ?? [];
    const match = rows.find((row) => row.printing === printing) ?? rows[0];
    return match?.marketCents ?? null;
  }, [pricesQuery.data, printing]);

  // Prefill the price field from market until the operator edits it.
  useEffect(() => {
    if (!priceTouched && marketCentsForPrinting != null) {
      setPriceDollars((marketCentsForPrinting / 100).toFixed(2));
    }
  }, [marketCentsForPrinting, priceTouched]);

  const sellPriceCents = Math.round((Number.parseFloat(priceDollars) || 0) * 100);
  const canSubmit = !!session.locationId && sellPriceCents >= 0 && quantity > 0 && !quickAdd.isPending;

  function submit() {
    if (!session.locationId) return;
    quickAdd.mutate(
      {
        pkmnpricesCardId: card ? Number(card.id) : undefined,
        name: card?.name ?? fallbackName,
        setName: card?.setName ?? null,
        setId: card?.setId ?? null,
        cardNumber: card?.number ?? fallbackNumber ?? null,
        rarity: card?.rarity ?? null,
        imageUrl: card?.imageUrl ?? null,
        locationId: session.locationId,
        quantity,
        condition,
        printing,
        language: 'EN',
        sellPriceCents,
        marketPriceCents: marketCentsForPrinting ?? undefined,
      },
      { onSuccess: onAdded },
    );
  }

  return (
    <div className="rounded-xl border border-brand/40 bg-brand/5 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand">
        Add to inventory
      </p>
      {!session.locationId && (
        <p className="mb-2 text-xs text-amber-300">Pick a location first to add stock.</p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="block text-xs">
          <span className="mb-1 block text-ink-muted">Qty</span>
          <input
            type="number"
            min={1}
            max={999}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
            className="min-h-10 w-full rounded-lg border border-border bg-navy px-2 text-sm outline-none focus:border-brand"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block text-ink-muted">Condition</span>
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as CardCondition)}
            className="min-h-10 w-full rounded-lg border border-border bg-navy px-2 text-sm outline-none focus:border-brand"
          >
            {CARD_CONDITIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block text-ink-muted">Printing</span>
          <select
            value={printing}
            onChange={(e) => setPrinting(e.target.value as CardPrinting)}
            className="min-h-10 w-full rounded-lg border border-border bg-navy px-2 text-sm outline-none focus:border-brand"
          >
            {CARD_PRINTINGS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block text-ink-muted">Sell price ($)</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={priceDollars}
            onChange={(e) => {
              setPriceTouched(true);
              setPriceDollars(e.target.value);
            }}
            placeholder={pricesQuery.isPending ? '…' : '0.00'}
            className="min-h-10 w-full rounded-lg border border-border bg-navy px-2 text-sm outline-none focus:border-brand"
          />
        </label>
      </div>
      {quickAdd.isError && (
        <p className="mt-2 text-xs text-rose-300">
          {quickAdd.error?.message ?? 'Could not add to inventory.'}
        </p>
      )}
      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="mt-3 w-full rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-navy disabled:cursor-not-allowed disabled:opacity-50"
      >
        {quickAdd.isPending ? 'Adding…' : 'Add to inventory'}
      </button>
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
