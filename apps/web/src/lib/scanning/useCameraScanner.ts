import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraScanner } from './types';
import { WebZxingScanner } from './webZxingScanner';
import { NativeMlkitScanner } from './nativeMlkitScanner';

export type CameraScannerStatus = 'idle' | 'starting' | 'scanning' | 'error';

function createScanner(): CameraScanner {
  if (Capacitor.isNativePlatform()) {
    return new NativeMlkitScanner();
  }
  return new WebZxingScanner();
}

/**
 * Hook providing a uniform camera scanner interface for both web and native.
 * Picks the implementation based on Capacitor.isNativePlatform().
 */
export function useCameraScanner(onDecode: (code: string) => void) {
  const scannerRef = useRef<CameraScanner | null>(null);
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;

  const [status, setStatus] = useState<CameraScannerStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const getScanner = useCallback(() => {
    if (!scannerRef.current) {
      scannerRef.current = createScanner();
    }
    return scannerRef.current;
  }, []);

  const start = useCallback(
    async (video: HTMLVideoElement) => {
      const scanner = getScanner();

      if (!scanner.isSupported()) {
        setStatus('error');
        setError('Camera scanning is not available on this device.');
        return;
      }

      setStatus('starting');
      setError(null);

      try {
        await scanner.start(video, (code) => onDecodeRef.current(code));
        setStatus('scanning');
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [getScanner],
  );

  const stop = useCallback(() => {
    scannerRef.current?.stop();
    setStatus((prev) => (prev === 'error' ? prev : 'idle'));
  }, []);

  useEffect(() => {
    return () => {
      scannerRef.current?.stop();
    };
  }, []);

  return {
    status,
    error,
    start,
    stop,
    isSupported:
      Capacitor.isNativePlatform() ||
      (typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function'),
  };
}
