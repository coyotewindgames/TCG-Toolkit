import { useEffect, type ReactNode } from 'react';

interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** width in tailwind classes, e.g. 'w-[28rem]' (default) */
  widthClass?: string;
}

/**
 * Right-side drawer panel. Slides in from the right.
 * - Click outside (overlay) to dismiss.
 * - ESC to dismiss.
 * - Persistent on lg screens? No — kept as overlay drawer for flexibility on any width.
 */
export default function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  children,
  widthClass = 'w-[28rem]',
}: SidePanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      {/* overlay */}
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-slate-950/60 backdrop-blur-sm transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      {/* panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed right-0 top-0 z-40 h-screen ${widthClass} max-w-full
                    bg-slate-900 border-l border-slate-700 shadow-2xl
                    flex flex-col
                    transform transition-transform duration-200 ease-out
                    ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <header className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{title}</h2>
            {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </>
  );
}

interface PanelSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** Collapsible section inside a SidePanel. */
export function PanelSection({ title, defaultOpen = true, children }: PanelSectionProps) {
  return (
    <details
      open={defaultOpen}
      className="group border border-slate-700 rounded-xl bg-slate-800/40 mb-4 last:mb-0 open:bg-slate-800/60"
    >
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between gap-2 select-none">
        <span className="font-semibold text-sm">{title}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-slate-400 transition-transform group-open:rotate-180"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
  );
}
