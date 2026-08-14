/**
 * Abstraction for a continuous camera-based barcode scanner.
 * Implementations exist for web (@zxing/browser) and native (@capacitor-mlkit/barcode-scanning).
 */
export interface CameraScanner {
  /** Begin continuous scanning. `onDecode` fires for each barcode detected. */
  start(video: HTMLVideoElement, onDecode: (code: string) => void): Promise<void>;
  /** Stop scanning and release camera resources. */
  stop(): void;
  /** Whether this scanner implementation is usable in the current environment. */
  isSupported(): boolean;
}
