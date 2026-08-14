import { Capacitor } from '@capacitor/core';
import type { CameraScanner } from './types';

/**
 * Native implementation using @capacitor-mlkit/barcode-scanning.
 * Uses the listener-based startScan()/addListener('barcodeScanned', ...) API
 * for continuous scanning that matches the existing RemoteScan UX.
 */
export class NativeMlkitScanner implements CameraScanner {
  private listenerHandle: { remove: () => Promise<void> } | null = null;

  isSupported(): boolean {
    return Capacitor.isNativePlatform();
  }

  async start(_video: HTMLVideoElement, onDecode: (code: string) => void): Promise<void> {
    this.stop();

    // Dynamically import to avoid bundling native-only code in web builds.
    const { BarcodeScanner: Scanner } = await import(
      '@capacitor-mlkit/barcode-scanning'
    );

    const perms = await Scanner.checkPermissions();
    if (perms.camera !== 'granted') {
      const req = await Scanner.requestPermissions();
      if (req.camera !== 'granted') {
        throw new Error('Camera permission denied');
      }
    }

    this.listenerHandle = await Scanner.addListener('barcodesScanned', (event) => {
      for (const barcode of event.barcodes) {
        const code = barcode.rawValue ?? barcode.displayValue;
        if (code) {
          onDecode(code);
        }
      }
    });

    await Scanner.startScan();
  }

  stop(): void {
    // Fire-and-forget async cleanup.
    void this.cleanup();
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.listenerHandle) {
        await this.listenerHandle.remove();
        this.listenerHandle = null;
      }
      const { BarcodeScanner } = await import(
        '@capacitor-mlkit/barcode-scanning'
      );
      await BarcodeScanner.stopScan();
    } catch {
      // Best-effort cleanup.
    }
  }
}
