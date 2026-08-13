/** Opens a fetched blob (PDF, image, etc.) in a new tab, falling back to a
 *  forced download if the popup was blocked. */
export function openOrDownloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
