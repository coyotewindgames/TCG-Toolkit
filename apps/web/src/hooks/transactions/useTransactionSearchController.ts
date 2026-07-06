import { useMemo, useState } from 'react';
import { useDebounced } from '../useBarcodeScanner';

export interface TransactionSearchControllerOptions {
  initialQuery?: string;
  debounceMs?: number;
  minQueryLength?: number;
  allowEmpty?: boolean;
}

export interface TransactionSearchController {
  query: string;
  setQuery: (value: string) => void;
  debouncedQuery: string;
  normalizedQuery: string;
  isSearchEnabled: boolean;
}

export function useTransactionSearchController(
  options: TransactionSearchControllerOptions = {},
): TransactionSearchController {
  const {
    initialQuery = '',
    debounceMs = 300,
    minQueryLength = 2,
    allowEmpty = false,
  } = options;

  const [query, setQuery] = useState(initialQuery);
  const debouncedQuery = useDebounced(query, debounceMs);
  const normalizedQuery = useMemo(() => debouncedQuery.trim(), [debouncedQuery]);

  const isSearchEnabled = useMemo(() => {
    if (allowEmpty && normalizedQuery.length === 0) return true;
    return normalizedQuery.length >= minQueryLength;
  }, [allowEmpty, minQueryLength, normalizedQuery]);

  return {
    query,
    setQuery,
    debouncedQuery,
    normalizedQuery,
    isSearchEnabled,
  };
}
