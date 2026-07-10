import { useEffect, useState } from 'react';

interface CardImageProps {
  src: string | null | undefined;
  alt: string;
  /** Optional aria label for the placeholder text. Defaults to "No image". */
  placeholderLabel?: string;
  className?: string;
}

/**
 * Card image with a graceful placeholder for missing or 404 URLs.
 *
 * pkmnprices doesn't publish images for every card (recent promo sets, some
 * World Championship decks, etc.), so we swap to a static placeholder instead
 * of leaving the browser's broken-image icon + raw alt text on screen.
 */
export default function CardImage({
  src,
  alt,
  placeholderLabel = 'No image',
  className,
}: CardImageProps) {
  const [failed, setFailed] = useState(false);

  // Reset the failure flag whenever the src changes so a new card gets a
  // fresh chance to load.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const showPlaceholder = !src || failed;

  return (
    <div
      className={`flex h-full w-full items-center justify-center bg-slate-800 ${className ?? ''}`}
    >
      {showPlaceholder ? (
        <span className="px-2 text-center text-[10px] uppercase tracking-wide text-slate-500">
          {placeholderLabel}
        </span>
      ) : (
        <img
          src={src ?? undefined}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      )}
    </div>
  );
}
