/**
 * Presentation helpers for money. One implementation so every surface renders
 * amounts identically.
 */

/** `1234` → `"$12.34"`; nullish → an em dash placeholder. */
export function formatCentsAsCurrency(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

/** Like {@link formatCentsAsCurrency} but with thousands separators. */
export function formatCentsAsCurrencyWithGrouping(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
