import { useState } from 'react';
import type { CatalogCard } from '@tcg/shared';
import { useVisionStatus } from '../../../hooks/transactions/useIdentifyCardFromImage';
import CardScanModal from './CardScanModal';

interface CardScanButtonProps {
  /** Whether the surrounding tab is active — gates the capability probe. */
  active: boolean;
  /** Called with the confirmed catalog card. */
  onConfirm: (card: CatalogCard) => void;
  confirmLabel?: string;
  className?: string;
}

/**
 * "Scan card" button that opens the camera identify modal. Renders nothing when
 * the server has no vision model configured, so the feature stays invisible
 * until it's provisioned.
 */
export default function CardScanButton({
  active,
  onConfirm,
  confirmLabel,
  className,
}: CardScanButtonProps) {
  const status = useVisionStatus(active);
  const [open, setOpen] = useState(false);

  if (!status.data?.enabled) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          'inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-navy px-4 text-sm font-medium text-ink transition hover:border-brand'
        }
      >
        <CameraIcon />
        Scan card
      </button>
      <CardScanModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={onConfirm}
        confirmLabel={confirmLabel}
      />
    </>
  );
}

function CameraIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
