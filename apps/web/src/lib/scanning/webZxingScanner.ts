import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import type { CameraScanner } from './types';

/**
 * Web implementation using @zxing/browser's BrowserMultiFormatReader.
 * Provides continuous camera scanning via decodeFromConstraints.
 */
export class WebZxingScanner implements CameraScanner {
  private reader: BrowserMultiFormatReader | null = null;
  private controls: IScannerControls | null = null;

  isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    );
  }

  async start(video: HTMLVideoElement, onDecode: (code: string) => void): Promise<void> {
    this.stop();

    if (!this.reader) {
      this.reader = new BrowserMultiFormatReader();
    }

    this.controls = await this.reader.decodeFromConstraints(
      {
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      },
      video,
      (result) => {
        if (result) {
          onDecode(result.getText());
        }
      },
    );
  }

  stop(): void {
    try {
      this.controls?.stop();
    } catch {
      // Ignore errors from stale media tracks.
    }
    this.controls = null;
  }
}
