import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

interface Product {
  id: string;
  name: string;
  imageSourceUrl?: string | null;
}

interface ProductImageEditorProps {
  product: Product;
  onClose: () => void;
  onSaved: (imageSourceUrl: string | null) => void;
}

/**
 * Resize an image File on the client so the payload stored in
 * `products.image_source_url` stays under ~120 KB. Standard trading-card
 * aspect ratios keep 480 × ~670 well under that.
 */
async function resizeToDataUrl(
  file: File,
  maxDimension = 480,
  quality = 0.85,
): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read image file.'));
    reader.readAsDataURL(file);
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image.'));
    img.src = dataUrl;
  });

  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2d context unavailable.');
  ctx.drawImage(image, 0, 0, width, height);

  // JPEG for photos, PNG for anything with transparency. Trading-card scans
  // are opaque, so JPEG at 85% is a good default.
  return canvas.toDataURL('image/jpeg', quality);
}

export default function ProductImageEditor({ product, onClose, onSaved }: ProductImageEditorProps) {
  const [preview, setPreview] = useState<string | null>(product.imageSourceUrl ?? null);
  const [pendingDataUrl, setPendingDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'remove'>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function onPick(file: File) {
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Image is too large (max 10 MB).');
      return;
    }
    try {
      const dataUrl = await resizeToDataUrl(file);
      setPendingDataUrl(dataUrl);
      setPreview(dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSave() {
    if (!pendingDataUrl) return;
    setBusy('save');
    setError(null);
    try {
      await api.put(`/products/${product.id}/image`, { dataUrl: pendingDataUrl });
      onSaved(pendingDataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function onRemove() {
    setBusy('remove');
    setError(null);
    try {
      await api.del(`/products/${product.id}/image`);
      onSaved(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close image editor"
        className="absolute inset-0 bg-black/70"
        onClick={() => (busy ? null : onClose())}
      />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Edit image</h2>
            <p className="text-sm text-slate-400 line-clamp-1">{product.name}</p>
          </div>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-200 text-sm"
            onClick={onClose}
            disabled={!!busy}
          >
            Close
          </button>
        </div>

        <div className="mt-4 flex justify-center">
          {preview ? (
            <img
              src={preview}
              alt="Product preview"
              className="max-h-72 w-auto rounded-md object-contain bg-slate-950 border border-slate-800"
            />
          ) : (
            <div className="w-32 h-48 rounded-md bg-slate-800 border border-dashed border-slate-700 flex items-center justify-center text-xs text-slate-500">
              No image
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPick(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={!!busy}
          >
            Choose file…
          </button>
          <button
            type="button"
            className="btn-primary disabled:opacity-50"
            onClick={() => void onSave()}
            disabled={!pendingDataUrl || !!busy}
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center px-3 py-2 rounded-lg text-sm bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => void onRemove()}
            disabled={!product.imageSourceUrl || !!busy}
            title="Remove the current image"
          >
            {busy === 'remove' ? 'Removing…' : 'Remove image'}
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-rose-300 text-center">{error}</p>}

        <p className="mt-3 text-xs text-slate-500 text-center">
          Images are resized to ~480 px and stored with your inventory. The auto-image
          job will leave this row alone until you clear the lock.
        </p>
      </div>
    </div>
  );
}
