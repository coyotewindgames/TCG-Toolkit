/**
 * Encode a value as base64url-encoded JSON, suitable for a URL fragment.
 * Used to hand a scoped session to the remote-scan page without putting it in
 * a query string (fragments are never sent to the server or logged by proxies).
 */
export function toBase64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
