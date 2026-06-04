import { describe, expect, it, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Vault, _resetVaultForTests } from '../src/security/vault';

function genKeyB64(): string {
  return randomBytes(32).toString('base64');
}

describe('Vault', () => {
  beforeEach(() => _resetVaultForTests());

  it('round-trips short and long plaintext', () => {
    const v = Vault.fromEnv({ CONFIG_ENCRYPTION_KEY: genKeyB64() } as NodeJS.ProcessEnv);
    for (const pt of ['', 'a', 'tcg_live_abcdef', 'x'.repeat(2048)]) {
      const blob = v.encrypt(pt);
      expect(v.decrypt(blob)).toBe(pt);
    }
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const v = Vault.fromEnv({ CONFIG_ENCRYPTION_KEY: genKeyB64() } as NodeJS.ProcessEnv);
    const a = v.encrypt('same');
    const b = v.encrypt('same');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('rejects ciphertext tampering via GCM auth tag', () => {
    const v = Vault.fromEnv({ CONFIG_ENCRYPTION_KEY: genKeyB64() } as NodeJS.ProcessEnv);
    const blob = v.encrypt('secret');
    const ctBuf = Buffer.from(blob.ciphertext, 'base64');
    ctBuf[0] ^= 0xff;
    expect(() => v.decrypt({ ...blob, ciphertext: ctBuf.toString('base64') })).toThrow();
  });

  it('refuses to decrypt with a key version it does not know', () => {
    const v = Vault.fromEnv({ CONFIG_ENCRYPTION_KEY: genKeyB64() } as NodeJS.ProcessEnv);
    const blob = v.encrypt('x');
    expect(() => v.decrypt({ ...blob, keyVersion: 99 })).toThrow(/v99/);
  });

  it('decrypts old blobs after key rotation', () => {
    const k1 = genKeyB64();
    const k2 = genKeyB64();
    const v1 = Vault.fromEnv({ CONFIG_ENCRYPTION_KEY: k1 } as NodeJS.ProcessEnv);
    const oldBlob = v1.encrypt('original');

    const v2 = Vault.fromEnv({
      CONFIG_ENCRYPTION_KEY: k1,
      CONFIG_ENCRYPTION_KEY_V2: k2,
    } as NodeJS.ProcessEnv);
    expect(v2.decrypt(oldBlob)).toBe('original');
    // New writes use the highest version.
    const newBlob = v2.encrypt('rotated');
    expect(newBlob.keyVersion).toBe(2);
    expect(v2.decrypt(newBlob)).toBe('rotated');
  });

  it('accepts hex-encoded keys too', () => {
    const hex = randomBytes(32).toString('hex');
    const v = Vault.fromEnv({ CONFIG_ENCRYPTION_KEY: hex } as NodeJS.ProcessEnv);
    expect(v.decrypt(v.encrypt('hello'))).toBe('hello');
  });

  it('rejects keys of the wrong length', () => {
    expect(() =>
      Vault.fromEnv({ CONFIG_ENCRYPTION_KEY: 'too-short' } as NodeJS.ProcessEnv),
    ).toThrow(/32 bytes/);
  });
});
