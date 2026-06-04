/**
 * AES-256-GCM vault for third-party credentials stored in Postgres.
 *
 * - GCM gives us both confidentiality and integrity (tampering with the
 *   ciphertext fails the auth-tag check on decrypt).
 * - The 12-byte IV is freshly randomised per encryption; storing it next to
 *   the ciphertext is standard practice and not a secret.
 * - `key_version` lets us rotate `CONFIG_ENCRYPTION_KEY` without downtime:
 *   point `CONFIG_ENCRYPTION_KEY_v2` (etc.) at the new key, bump the writer's
 *   default version, and re-encrypt old rows lazily on next read.
 *
 * Keys may be supplied as base64 or hex; either way the decoded buffer must
 * be exactly 32 bytes.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedBlob {
  ciphertext: string; // base64
  iv: string; // base64 (12 bytes)
  tag: string; // base64 (16 bytes)
  keyVersion: number;
}

export interface VaultOptions {
  /** Map of key version → 32-byte key. Version 1 is the default writer key. */
  keys: Map<number, Buffer>;
  /** Version used when encrypting new blobs. Defaults to the highest key. */
  writerVersion?: number;
}

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function decodeKey(raw: string): Buffer {
  // Try base64 first; if it round-trips cleanly to KEY_BYTES, use it.
  // Otherwise fall back to hex. Strict checks keep silent truncation errors away.
  const trimmed = raw.trim();
  const fromB64 = (() => {
    try {
      const b = Buffer.from(trimmed, 'base64');
      // base64 of 32 bytes is 44 chars ending in '='; verify round trip
      if (b.length === KEY_BYTES && b.toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '')) {
        return b;
      }
    } catch {
      /* fallthrough */
    }
    return null;
  })();
  if (fromB64) return fromB64;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
    return Buffer.from(trimmed, 'hex');
  }
  throw new Error(
    `CONFIG_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (base64 or hex). Got ${trimmed.length} chars.`,
  );
}

export class Vault {
  private readonly keys: Map<number, Buffer>;
  private readonly writerVersion: number;

  constructor(opts: VaultOptions) {
    if (opts.keys.size === 0) throw new Error('Vault requires at least one key');
    for (const [v, k] of opts.keys) {
      if (k.length !== KEY_BYTES) {
        throw new Error(`Vault key v${v} is ${k.length} bytes; expected ${KEY_BYTES}`);
      }
    }
    this.keys = opts.keys;
    this.writerVersion = opts.writerVersion ?? Math.max(...opts.keys.keys());
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Vault {
    const keys = new Map<number, Buffer>();
    if (env.CONFIG_ENCRYPTION_KEY) {
      keys.set(1, decodeKey(env.CONFIG_ENCRYPTION_KEY));
    }
    // Optional rotation slots: CONFIG_ENCRYPTION_KEY_V2, _V3, …
    for (const [k, v] of Object.entries(env)) {
      const m = /^CONFIG_ENCRYPTION_KEY_V(\d+)$/.exec(k);
      if (m && v) keys.set(Number(m[1]), decodeKey(v));
    }
    return new Vault({ keys });
  }

  encrypt(plaintext: string): EncryptedBlob {
    const iv = randomBytes(IV_BYTES);
    const key = this.keys.get(this.writerVersion);
    if (!key) throw new Error(`writer key v${this.writerVersion} missing`);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ct.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.writerVersion,
    };
  }

  decrypt(blob: EncryptedBlob): string {
    const key = this.keys.get(blob.keyVersion);
    if (!key) throw new Error(`vault key v${blob.keyVersion} not loaded`);
    const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(blob.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return pt.toString('utf8');
  }

  /** True when a blob is encrypted with the current writer key. */
  isCurrent(blob: EncryptedBlob): boolean {
    return blob.keyVersion === this.writerVersion;
  }
}

let cached: Vault | null = null;
export function getVault(): Vault {
  if (cached) return cached;
  cached = Vault.fromEnv();
  return cached;
}

// Test-only reset hook.
export function _resetVaultForTests(): void {
  cached = null;
}
