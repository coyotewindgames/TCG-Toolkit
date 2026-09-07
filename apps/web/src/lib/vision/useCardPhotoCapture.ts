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
          // Request a high-resolution rear camera so the intrinsic frame has
          // enough detail to read a card's collector number after cropping.
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
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

  // Web only: grab the current preview frame as a JPEG data URL. When a
  // `cropGuide` element is passed (the on-screen framing box), the frame is
  // cropped to exactly what the operator lined up inside it — so only the card,
  // not the surrounding desk/table, is sent to the model.
  const captureFromPreview = useCallback((cropGuide?: HTMLElement | null): string | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const region = cropGuide ? cropRegionFromGuide(video, cropGuide) : null;
    const dataUrl = drawToJpeg(video, region);
    if (dataUrl) setStatus('captured');
    return dataUrl;
  }, []);

  // Native only: open the OS camera and return the captured photo data URL,
  // auto-cropped to a card shape. The native OS camera can't render our guide
  // overlay, so we capture the full frame and centre-crop it to the standard
  // card aspect ratio — the equivalent of "fit the guide box" for a centred
  // card. `allowEditing` stays off so the crop is fully automatic.
  const captureNative = useCallback(async (): Promise<string | null> => {
    if (!isNative) return null;
    setStatus('starting');
    setError(null);
    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
      const photo = await Camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
        // Capture large so small on-card text survives the centre-crop.
        width: 2048,
        correctOrientation: true,
      });
      const raw = photo.dataUrl ?? null;
      if (!raw) {
        setStatus('idle');
        return null;
      }
      // Auto-crop to the card aspect; fall back to the raw photo if the crop
      // can't be computed (e.g. image decode issue).
      const cropped = await cropDataUrlToCardAspect(raw).catch(() => raw);
      setStatus('captured');
      return cropped;
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
 * A source sub-rectangle (in the video's intrinsic pixels) to crop before
 * encoding. Omitted → the whole frame is used.
 */
interface SourceRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Map the on-screen framing guide to a crop rectangle in the video's intrinsic
 * pixels, accounting for the `<video>`'s `object-cover` scaling (which scales
 * the frame to fill the box and centre-crops the overflow). A small margin is
 * added so slightly-imperfect framing doesn't clip the card's edges.
 */
function cropRegionFromGuide(
  video: HTMLVideoElement,
  guide: HTMLElement,
): SourceRegion | null {
  const vRect = video.getBoundingClientRect();
  const gRect = guide.getBoundingClientRect();
  const Wi = video.videoWidth;
  const Hi = video.videoHeight;
  if (!Wi || !Hi || !vRect.width || !vRect.height) return null;

  // object-cover: scale so the frame covers the box, overflow centred.
  const scale = Math.max(vRect.width / Wi, vRect.height / Hi);
  const offX = (vRect.width - Wi * scale) / 2;
  const offY = (vRect.height - Hi * scale) / 2;

  // Guide position relative to the video box.
  const gx = gRect.left - vRect.left;
  const gy = gRect.top - vRect.top;

  // Tiny breathing room (~2%) so the card's edges aren't clipped while still
  // fitting the guide box closely — the operator lines the card up to fill it.
  const marginX = gRect.width * 0.02;
  const marginY = gRect.height * 0.02;

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  let sx = (gx - offX - marginX) / scale;
  let sy = (gy - offY - marginY) / scale;
  let sw = (gRect.width + marginX * 2) / scale;
  let sh = (gRect.height + marginY * 2) / scale;

  sx = clamp(sx, 0, Wi);
  sy = clamp(sy, 0, Hi);
  sw = clamp(sw, 1, Wi - sx);
  sh = clamp(sh, 1, Hi - sy);

  // Guard against a degenerate crop (e.g. layout not yet measured).
  if (sw < 8 || sh < 8) return null;
  return { sx, sy, sw, sh };
}

/**
 * Draw a video frame (optionally a cropped sub-region) to an offscreen canvas,
 * upscaling/downscaling so the longest edge is at most `MAX_EDGE`, and encode as
 * JPEG. Cropping to the card lets us push a higher effective resolution on the
 * part that matters (name/number) while staying under the API's image cap.
 */
function drawToJpeg(video: HTMLVideoElement, region: SourceRegion | null): string | null {
  const MAX_EDGE = 1600;
  const sx = region?.sx ?? 0;
  const sy = region?.sy ?? 0;
  const sw = region?.sw ?? video.videoWidth;
  const sh = region?.sh ?? video.videoHeight;

  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const targetW = Math.max(1, Math.round(sw * scale));
  const targetH = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
  return canvas.toDataURL('image/jpeg', 0.85);
}
