import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

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

export interface GuideAlignment {
  /** 0..1 measure of how much sharp, card-like detail fills the guide box. */
  score: number;
  /** True once the score crosses the "well-framed" threshold. */
  aligned: boolean;
}

/**
 * Live feedback for the framing guide: samples the video region inside the
 * guide a few times a second and scores how much sharp, high-contrast detail
 * fills it. A card lined up in the frame (in focus, filling the box) produces a
 * high gradient-energy score; an empty desk scores low. The modal uses this to
 * "light up" the guide when the operator is well-aligned.
 *
 * This is a focus/fill heuristic, not true edge detection — cheap, robust to
 * background, and good enough to nudge the operator to hold steady.
 */
export function useGuideAlignment(params: {
  active: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  guideRef: RefObject<HTMLElement | null>;
}): GuideAlignment {
  const { active, videoRef, guideRef } = params;
  const [state, setState] = useState<GuideAlignment>({ score: 0, aligned: false });

  useEffect(() => {
    if (!active) {
      setState({ score: 0, aligned: false });
      return;
    }
    let stopped = false;
    let raf = 0;
    let last = 0;
    const SAMPLE = 72;
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const loop = (t: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      if (t - last < 160) return; // throttle to ~6fps
      last = t;
      const video = videoRef.current;
      const guide = guideRef.current;
      if (!video || !guide || !ctx || !video.videoWidth) return;
      const region = cropRegionFromGuide(video, guide);
      if (!region) return;

      ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, SAMPLE, SAMPLE);
      let imageData: ImageData;
      try {
        imageData = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
      } catch {
        return; // e.g. transient issue reading pixels; skip this frame
      }
      const { data } = imageData;

      // Grayscale, then average gradient magnitude (edge energy) as a
      // focus/detail proxy.
      const gray = new Float32Array(SAMPLE * SAMPLE);
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      let energy = 0;
      let n = 0;
      for (let y = 0; y < SAMPLE; y += 1) {
        for (let x = 0; x < SAMPLE - 1; x += 1) {
          const idx = y * SAMPLE + x;
          energy += Math.abs(gray[idx] - gray[idx + 1]);
          if (y < SAMPLE - 1) energy += Math.abs(gray[idx] - gray[idx + SAMPLE]);
          n += 1;
        }
      }
      const meanGradient = n > 0 ? energy / (n * 2) : 0; // 0..255
      const score = Math.max(0, Math.min(1, meanGradient / 22)); // tuned divisor

      setState((prev) => {
        const aligned = score > 0.42;
        if (prev.aligned === aligned && Math.abs(prev.score - score) < 0.03) return prev;
        return { score, aligned };
      });
    };

    raf = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [active, videoRef, guideRef]);

  return state;
}

/**
 * A source sub-rectangle (in the source image's intrinsic pixels) to crop
 * before encoding. Omitted → the whole frame is used.
 */
interface SourceRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Standard TCG card aspect ratio (width / height ≈ 63mm / 88mm). Matches the
 * on-screen guide box, so web (guide crop) and native (centre crop) agree. */
const CARD_ASPECT = 5 / 7;

/** Longest edge of the encoded image. Cropping to the card lets us spend this
 * budget on the part that matters (name/number) instead of the whole desk. */
const MAX_EDGE = 1600;

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
  const sx = region?.sx ?? 0;
  const sy = region?.sy ?? 0;
  const sw = region?.sw ?? video.videoWidth;
  const sh = region?.sh ?? video.videoHeight;
  return drawSourceToJpeg(video, sx, sy, sw, sh);
}

/**
 * Shared encoder: draw a sub-region of any decoded image source to a canvas,
 * scaled so the longest edge is `MAX_EDGE`, and return a JPEG data URL.
 */
function drawSourceToJpeg(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): string | null {
  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const targetW = Math.max(1, Math.round(sw * scale));
  const targetH = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, targetW, targetH);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Centre-crop rectangle for a given target aspect (width / height). */
function centerCropRegion(width: number, height: number, aspect: number): SourceRegion {
  const currentAspect = width / height;
  if (currentAspect > aspect) {
    // Too wide — trim the sides.
    const sw = Math.round(height * aspect);
    return { sx: Math.round((width - sw) / 2), sy: 0, sw, sh: height };
  }
  // Too tall — trim top/bottom.
  const sh = Math.round(width / aspect);
  return { sx: 0, sy: Math.round((height - sh) / 2), sw: width, sh };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to decode captured image'));
    img.src = dataUrl;
  });
}

/**
 * Centre-crop a captured photo data URL to the standard card aspect ratio and
 * re-encode. Used on native, where the OS camera can't overlay our guide box —
 * a centred card ends up cropped to the same shape the web guide produces.
 */
async function cropDataUrlToCardAspect(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return dataUrl;
  const region = centerCropRegion(w, h, CARD_ASPECT);
  return drawSourceToJpeg(img, region.sx, region.sy, region.sw, region.sh) ?? dataUrl;
}
