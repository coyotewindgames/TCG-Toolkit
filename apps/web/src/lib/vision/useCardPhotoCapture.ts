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
  /** 0..1 fraction of the guide's rectangular outline that a card edge covers. */
  score: number;
  /** True once a card-shaped object is detected filling the guide. */
  aligned: boolean;
}

/**
 * Live feedback for the framing guide, tuned to detect an actual *card* — not
 * just "something textured" — in the frame.
 *
 * A raw edge-energy score lights up on any busy background (desk clutter,
 * patterns, text), which produced false "aligned" states. Instead we look for
 * the two things that specifically indicate a card filling the guide box:
 *   1. A rectangular EDGE CONTOUR around the guide perimeter — a card's four
 *      borders create a strong luminance step along most of the guide's outline
 *      (searched within a small band so the card can sit slightly in/out).
 *   2. INTERIOR DETAIL inside that contour — a card has art/text, ruling out a
 *      blank rectangle. Random background clutter rarely produces a continuous
 *      rectangular contour aligned to the guide, so it no longer triggers.
 *
 * Still a heuristic (not full CV), but far more card-specific than edge energy.
 * Hysteresis keeps the "aligned" state from flickering.
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
    let wasAligned = false;
    const SAMPLE = 96;
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const loop = (t: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      if (t - last < 140) return; // throttle to ~7fps
      last = t;
      const video = videoRef.current;
      const guide = guideRef.current;
      if (!video || !guide || !ctx || !video.videoWidth) return;
      const region = cropRegionFromGuide(video, guide);
      if (!region) return;

      // Sample a region slightly LARGER than the guide so the card's border —
      // which sits near the guide edge — is visible against the background.
      const ex = region.sw * 0.25;
      const ey = region.sh * 0.25;
      let X = region.sx - ex;
      let Y = region.sy - ey;
      let W = region.sw + ex * 2;
      let H = region.sh + ey * 2;
      X = Math.max(0, X);
      Y = Math.max(0, Y);
      W = Math.min(video.videoWidth - X, W);
      H = Math.min(video.videoHeight - Y, H);
      if (W < 8 || H < 8) return;

      ctx.drawImage(video, X, Y, W, H, 0, 0, SAMPLE, SAMPLE);
      let imageData: ImageData;
      try {
        imageData = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
      } catch {
        return; // e.g. transient issue reading pixels; skip this frame
      }
      const { data } = imageData;

      const gray = new Float32Array(SAMPLE * SAMPLE);
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      const lum = (x: number, y: number): number => {
        const cx = x < 0 ? 0 : x > SAMPLE - 1 ? SAMPLE - 1 : Math.round(x);
        const cy = y < 0 ? 0 : y > SAMPLE - 1 ? SAMPLE - 1 : Math.round(y);
        return gray[cy * SAMPLE + cx];
      };

      // Guide rectangle position within the (larger) sampled canvas.
      const gL = ((region.sx - X) / W) * SAMPLE;
      const gT = ((region.sy - Y) / H) * SAMPLE;
      const gR = ((region.sx + region.sw - X) / W) * SAMPLE;
      const gB = ((region.sy + region.sh - Y) / H) * SAMPLE;
      const gWpx = gR - gL;
      const gHpx = gB - gT;
      if (gWpx < 8 || gHpx < 8) return;

      // Search band + step threshold for a card edge along the guide outline.
      const band = Math.max(3, Math.min(gWpx, gHpx) * 0.12);
      const STEP = 26; // luminance jump that reads as a real edge
      const PER_SIDE = 22;

      const edgeAt = (px: number, py: number, nx: number, ny: number): boolean => {
        let maxStep = 0;
        for (let o = -band; o <= band; o += 2) {
          const a = lum(px + nx * (o - 2), py + ny * (o - 2));
          const b = lum(px + nx * (o + 2), py + ny * (o + 2));
          const s = Math.abs(b - a);
          if (s > maxStep) maxStep = s;
        }
        return maxStep > STEP;
      };

      let edgePts = 0;
      let totalPts = 0;
      for (let i = 0; i < PER_SIDE; i += 1) {
        const fx = gL + (gWpx * (i + 0.5)) / PER_SIDE;
        totalPts += 2;
        if (edgeAt(fx, gT, 0, 1)) edgePts += 1; // top edge, normal points inward (down)
        if (edgeAt(fx, gB, 0, -1)) edgePts += 1; // bottom edge, inward (up)
      }
      for (let i = 0; i < PER_SIDE; i += 1) {
        const fy = gT + (gHpx * (i + 0.5)) / PER_SIDE;
        totalPts += 2;
        if (edgeAt(gL, fy, 1, 0)) edgePts += 1; // left edge, inward (right)
        if (edgeAt(gR, fy, -1, 0)) edgePts += 1; // right edge, inward (left)
      }
      const coverage = totalPts > 0 ? edgePts / totalPts : 0;

      // Interior detail: mean gradient in the central 70% of the guide, to rule
      // out a blank card-sized object (e.g. a sheet of paper).
      const iL = Math.floor(gL + gWpx * 0.15);
      const iR = Math.ceil(gR - gWpx * 0.15);
      const iT = Math.floor(gT + gHpx * 0.15);
      const iB = Math.ceil(gB - gHpx * 0.15);
      let e = 0;
      let c = 0;
      for (let y = iT; y < iB - 1; y += 1) {
        for (let x = iL; x < iR - 1; x += 1) {
          e += Math.abs(lum(x + 1, y) - lum(x, y)) + Math.abs(lum(x, y + 1) - lum(x, y));
          c += 1;
        }
      }
      const interiorDetail = c > 0 ? e / (c * 2) : 0;
      const detailOK = interiorDetail > 4;

      // Hysteresis: harder to latch on, easier to hold, so it doesn't flicker.
      const aligned = detailOK && (wasAligned ? coverage > 0.42 : coverage > 0.6);
      wasAligned = aligned;
      const score = coverage;

      setState((prev) => {
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
