import { useEffect, useMemo, useRef, useState } from 'react';

export type SearchableSelectOption = {
  value: string;
  label: string;
};

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
  className?: string;
}

export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  disabled = false,
  emptyLabel = 'No matches',
  className = '',
}: SearchableSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = options.find((option) => option.value === value) ?? null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label} ${option.value}`.toLowerCase().includes(needle),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function selectValue(next: string) {
    onChange(next);
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <input
        type="text"
        value={open ? query : selected?.label ?? ''}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (!disabled) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            setQuery('');
          }
          if (event.key === 'Enter' && open && filtered[0]) {
            event.preventDefault();
            selectValue(filtered[0].value);
          }
        }}
        placeholder={open ? searchPlaceholder ?? placeholder : placeholder}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 pr-9 text-sm outline-none focus:border-emerald-500 disabled:opacity-50"
      />
      {value && !disabled && (
        <button
          type="button"
          aria-label="Clear selection"
          className="absolute right-8 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"
          onClick={() => selectValue('')}
        >
          x
        </button>
      )}
      <button
        type="button"
        aria-label="Toggle options"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 disabled:opacity-50"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        v
      </button>
      {open && !disabled && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-700 bg-slate-950 shadow-xl">
          <button
            type="button"
            className={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-800 ${
              value === '' ? 'text-emerald-300' : 'text-slate-200'
            }`}
            onClick={() => selectValue('')}
          >
            {placeholder}
          </button>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-500">{emptyLabel}</div>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-800 ${
                  option.value === value ? 'text-emerald-300' : 'text-slate-200'
                }`}
                onClick={() => selectValue(option.value)}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
