import { useEffect, useRef, useState } from 'react';

/**
 * Listens for keyboard "burst" input typical of USB HID barcode scanners
 * (rapid characters terminated by Enter). Returns the latest scanned value
 * and clears after each consumer reads it via the provided reset callback.
 */
export function useBarcodeScanner(onScan: (code: string) => void, opts?: { minLength?: number; gapMs?: number }) {
  const bufferRef = useRef<string>('');
  const lastTsRef = useRef<number>(0);
  const min = opts?.minLength ?? 4;
  const gap = opts?.gapMs ?? 50;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const now = Date.now();
      if (now - lastTsRef.current > 500) bufferRef.current = '';
      lastTsRef.current = now;
      if (e.key === 'Enter') {
        const code = bufferRef.current.trim();
        bufferRef.current = '';
        if (code.length >= min) onScan(code);
        return;
      }
      if (e.key.length === 1 && now - lastTsRef.current <= gap + 500) {
        bufferRef.current += e.key;
      } else if (e.key.length === 1) {
        bufferRef.current = e.key;
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onScan, min, gap]);
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
