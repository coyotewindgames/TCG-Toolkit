/** Generate an opaque, URL-safe barcode token: `TCG-<base32(uuid)>`. */
import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32

export function generateBarcodeToken(prefix = 'TCG'): string {
  const bytes = randomBytes(10); // 80 bits → 16 base32 chars
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return `${prefix}-${out}`;
}
