import type { ReactNode } from 'react';
import type { CatalogCard } from '@tcg/shared';
import CardScanButton from './vision/CardScanButton';

export interface TransactionEntryScanConfig {
  /** Gates the vision capability probe to the active tab. */
  active: boolean;
  /** Called with the confirmed catalog card. */
  onConfirm: (card: CatalogCard) => void;
  confirmLabel?: string;
  /** Offer "Add to inventory" for cards not yet stocked (Sell). */
  allowAddToInventory?: boolean;
  /** Called after a successful quick-add so the caller can refresh its list. */
  onAdded?: () => void;
}

interface TransactionEntryBarProps {
  /** Uppercase label above the input (e.g. "Search inventory"). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Camera scan config; the button hides itself when vision is unconfigured. */
  scan: TransactionEntryScanConfig;
  /** Extra controls rendered directly under the input row (filters, chips). */
  children?: ReactNode;
}

/**
 * Unified item-entry surface shared by every Buy / Sell / Trade mode.
 *
 * Consolidates what used to be three slightly-different search+camera clusters
 * into one consistent control: a labelled full-width input with the camera
 * "Scan card" button pinned to its right, plus an optional slot beneath for
 * mode-specific controls (catalog filters on Buy/Trade, none on Sell). Keeping
 * this in one place means the primary interaction looks and behaves identically
 * no matter which mode the operator is in.
 */
export default function TransactionEntryBar({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  scan,
  children,
}: TransactionEntryBarProps) {
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-muted">
          {label}
        </span>
        <div className="flex items-stretch gap-2">
          <input
            autoFocus={autoFocus}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            className="min-h-11 w-full rounded-xl border border-border bg-navy px-4 text-base outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/40"
          />
          <CardScanButton
            active={scan.active}
            onConfirm={scan.onConfirm}
            confirmLabel={scan.confirmLabel}
            allowAddToInventory={scan.allowAddToInventory}
            onAdded={scan.onAdded}
          />
        </div>
      </label>
      {children}
    </div>
  );
}
