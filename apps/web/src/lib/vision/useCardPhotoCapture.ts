import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useRef, useState } from 'react';

export type CardPhotoCaptureStatus =
  | 'idle'
  | 'starting'
  | 'previewing'
  | 'captured'
  | 'error';

/**
 * Still-photo capture for the "snap-to-identify" card camera. Deliberately
 * separate from `useCameraScanner` (which does *continuous* barcode decoding):
 * here we want a single high-resolution frame of the card face to hand to the
 * vision model.
 *
 * Platform split mirrors the scanner:
 *  - Web: `getUserMedia` drives a live <video> preview; the operator frames the
 *    card and taps capture, which draws the current frame to a canvas and
 *    returns a downscaled JPEG data URL.
 *  - Native (Capacitor): the OS camera UI handles preview/capture via
 *    `@capacitor/camera`; `captureNative()` returns the photo data URL directly
 *    and the <video> preview is unused.
 *
 * The returned data URL is downscaled/compressed to stay under the API's
 * ~780 KB image cap while keeping the card text legible for OCR.
 */
export function useCardPhotoCapture() {
  const isNative = Capacitor.isNativePlatform();
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [status, setStatus] = useState<CardPhotoCaptureStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const isSupported =
    isNative ||
    (typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function');

  const stop = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStatus((prev) => (prev === 'error' ? prev : 'idle'));
  }, []);

  // Web only: attach a rear-facing camera stream to the given <video> element.
  const startPreview = useCallback(
    async (video: HTMLVideoElement) => {
      if (isNative) return; // native uses its own camera UI
      if (!isSupported) {
        setStatus('error');
        setError('Camera is not available on this device.');
        return;
      }
      setStatus('starting');
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        streamRef.current = stream;
        videoRef.current = video;
        video.srcObject = stream;
        await video.play();
        setStatus('previewing');
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Could not access the camera.');
      }
    },
    [isNative, isSupported],
  );

  // Web only: grab the current preview frame as a downscaled JPEG data URL.
  const captureFromPreview = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const dataUrl = drawToJpeg(video, video.videoWidth, video.videoHeight);
    if (dataUrl) setStatus('captured');
    return dataUrl;
  }, []);

  // Native only: open the OS camera and return the captured photo data URL.
  const captureNative = useCallback(async (): Promise<string | null> => {
    if (!isNative) return null;
    setStatus('starting');
    setError(null);
    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
      const photo = await Camera.getPhoto({
        quality: 80,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
        width: 1024,
        correctOrientation: true,
      });
      const dataUrl = photo.dataUrl ?? null;
      setStatus(dataUrl ? 'captured' : 'idle');
      return dataUrl;
    } catch (err) {
      // The user cancelling the native camera throws — treat as a soft idle,
      // not an error banner.
      const message = err instanceof Error ? err.message : String(err);
      if (/cancel/i.test(message)) {
        setStatus('idle');
        return null;
      }
      setStatus('error');
      setError(message);
      return null;
    }
  }, [isNative]);

  const reset = useCallback(() => {
    setError(null);
    setStatus('idle');
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return {
    isNative,
    isSupported,
    status,
    error,
    startPreview,
    captureFromPreview,
    captureNative,
    stop,
    reset,
  };
}

/**
 * Draw a video frame to an offscreen canvas, downscaling so the longest edge is
 * at most `MAX_EDGE` px, and encode as JPEG. Keeps the payload small enough for
 * the API's image cap while preserving enough detail for the model to read the
 * card name/number.
 */
function drawToJpeg(source: CanvasImageSource, width: number, height: number): string | null {
  const MAX_EDGE = 1024;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, targetW, targetH);
  return canvas.toDataURL('image/jpeg', 0.8);
}
