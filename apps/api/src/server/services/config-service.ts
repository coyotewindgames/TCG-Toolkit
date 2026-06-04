/**
 * Per-store credential store for third-party integrations.
 *
 * Reads/writes the encrypted `tcgapi_configs` and `pos_configs` tables and
 * exposes plaintext only behind explicit method calls. The in-process cache
 * lives 60s by default so settings UI updates propagate quickly without
 * hammering the DB on every request.
 *
 * Single-instance assumption: invalidating the cache on PUT only clears the
 * local process. Multi-instance deployments should swap `invalidate()` for a
 * Redis pub/sub fan-out — left as a future hook (`onInvalidate`).
 */
import { eq } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { getVault, type Vault, type EncryptedBlob } from '../../security/vault';
import { NotFound } from '../../common/http-errors';

export interface TcgapiCreds {
  baseUrl: string;
  apiKey: string;
}

export interface PosCreds {
  provider: 'clover';
  baseUrl: string;
  merchantId: string;
  accessToken: string;
  webhookSigningSecret: string;
}

export interface UpsertTcgapiInput {
  storeId: string;
  baseUrl: string;
  apiKey?: string; // omit to keep existing
  actorId?: string | null;
  actorIp?: string | null;
}

export interface UpsertPosInput {
  storeId: string;
  baseUrl: string;
  merchantId: string;
  accessToken?: string; // omit to keep existing
  webhookSigningSecret?: string; // omit to keep existing
  actorId?: string | null;
  actorIp?: string | null;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const TTL_MS = 60_000;

export class ConfigService {
  private readonly tcgapiCache = new Map<string, CacheEntry<TcgapiCreds>>();
  private readonly posCache = new Map<string, CacheEntry<PosCreds>>();
  private readonly posByMerchantCache = new Map<string, CacheEntry<{ storeId: string } & PosCreds>>();

  constructor(
    private readonly db: Database,
    private readonly vault: Vault = getVault(),
  ) {}

  // ---- TCGapi --------------------------------------------------------------

  async getTcgapi(storeId: string): Promise<TcgapiCreds> {
    const hit = this.tcgapiCache.get(storeId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const [row] = await this.db
      .select()
      .from(schema.tcgapiConfigs)
      .where(eq(schema.tcgapiConfigs.storeId, storeId))
      .limit(1);
    if (!row) throw NotFound(`tcgapi config not set for store ${storeId}`);

    const apiKey = this.vault.decrypt(this.blob(row.apiKeyCiphertext, row.apiKeyIv, row.apiKeyTag, row.keyVersion));
    const value: TcgapiCreds = { baseUrl: row.baseUrl, apiKey };
    this.tcgapiCache.set(storeId, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  }

  async getTcgapiStatus(storeId: string): Promise<{
    configured: boolean;
    baseUrl: string;
    hasKey: boolean;
    lastVerifiedAt: Date | null;
    updatedAt: Date | null;
  }> {
    const [row] = await this.db
      .select()
      .from(schema.tcgapiConfigs)
      .where(eq(schema.tcgapiConfigs.storeId, storeId))
      .limit(1);
    if (!row) {
      return { configured: false, baseUrl: 'https://api.tcgapi.dev/v1', hasKey: false, lastVerifiedAt: null, updatedAt: null };
    }
    return {
      configured: true,
      baseUrl: row.baseUrl,
      hasKey: row.apiKeyCiphertext.length > 0,
      lastVerifiedAt: row.lastVerifiedAt,
      updatedAt: row.updatedAt,
    };
  }

  async upsertTcgapi(input: UpsertTcgapiInput): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(schema.tcgapiConfigs)
      .where(eq(schema.tcgapiConfigs.storeId, input.storeId))
      .limit(1);

    let blob: EncryptedBlob;
    if (input.apiKey) {
      blob = this.vault.encrypt(input.apiKey);
    } else if (existing) {
      blob = {
        ciphertext: existing.apiKeyCiphertext,
        iv: existing.apiKeyIv,
        tag: existing.apiKeyTag,
        keyVersion: existing.keyVersion,
      };
    } else {
      throw new Error('apiKey is required when creating a new TCGapi config');
    }

    if (existing) {
      await this.db
        .update(schema.tcgapiConfigs)
        .set({
          baseUrl: input.baseUrl,
          apiKeyCiphertext: blob.ciphertext,
          apiKeyIv: blob.iv,
          apiKeyTag: blob.tag,
          keyVersion: blob.keyVersion,
          updatedBy: input.actorId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.tcgapiConfigs.storeId, input.storeId));
    } else {
      await this.db.insert(schema.tcgapiConfigs).values({
        storeId: input.storeId,
        baseUrl: input.baseUrl,
        apiKeyCiphertext: blob.ciphertext,
        apiKeyIv: blob.iv,
        apiKeyTag: blob.tag,
        keyVersion: blob.keyVersion,
        updatedBy: input.actorId ?? null,
      });
    }

    await this.audit({
      storeId: input.storeId,
      tableName: 'tcgapi_configs',
      action: existing ? 'update' : 'create',
      actorId: input.actorId,
      actorIp: input.actorIp,
    });
    this.tcgapiCache.delete(input.storeId);
  }

  async markTcgapiVerified(storeId: string, actorId?: string | null, actorIp?: string | null): Promise<void> {
    await this.db
      .update(schema.tcgapiConfigs)
      .set({ lastVerifiedAt: new Date() })
      .where(eq(schema.tcgapiConfigs.storeId, storeId));
    await this.audit({ storeId, tableName: 'tcgapi_configs', action: 'verify', actorId, actorIp });
  }

  // ---- POS (Clover) --------------------------------------------------------

  async getPos(storeId: string): Promise<PosCreds> {
    const hit = this.posCache.get(storeId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const [row] = await this.db
      .select()
      .from(schema.posConfigs)
      .where(eq(schema.posConfigs.storeId, storeId))
      .limit(1);
    if (!row) throw NotFound(`pos config not set for store ${storeId}`);

    const accessToken = this.vault.decrypt(
      this.blob(row.accessTokenCiphertext, row.accessTokenIv, row.accessTokenTag, row.keyVersion),
    );
    const webhookSigningSecret = this.vault.decrypt(
      this.blob(row.webhookSecretCiphertext, row.webhookSecretIv, row.webhookSecretTag, row.keyVersion),
    );

    const value: PosCreds = {
      provider: row.provider,
      baseUrl: row.baseUrl,
      merchantId: row.merchantId,
      accessToken,
      webhookSigningSecret,
    };
    this.posCache.set(storeId, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  }

  /**
   * Used by the webhook handler — looks up the owning store from the
   * Clover-supplied merchant id (plaintext, indexed) so we can decrypt the
   * signing secret before verifying the HMAC.
   */
  async getPosByMerchantId(merchantId: string): Promise<{ storeId: string } & PosCreds> {
    const hit = this.posByMerchantCache.get(merchantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const [row] = await this.db
      .select()
      .from(schema.posConfigs)
      .where(eq(schema.posConfigs.merchantId, merchantId))
      .limit(1);
    if (!row) throw NotFound(`no pos config matches merchant ${merchantId}`);

    const accessToken = this.vault.decrypt(
      this.blob(row.accessTokenCiphertext, row.accessTokenIv, row.accessTokenTag, row.keyVersion),
    );
    const webhookSigningSecret = this.vault.decrypt(
      this.blob(row.webhookSecretCiphertext, row.webhookSecretIv, row.webhookSecretTag, row.keyVersion),
    );
    const value = {
      storeId: row.storeId,
      provider: row.provider,
      baseUrl: row.baseUrl,
      merchantId: row.merchantId,
      accessToken,
      webhookSigningSecret,
    };
    this.posByMerchantCache.set(merchantId, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  }

  async getPosStatus(storeId: string): Promise<{
    configured: boolean;
    provider: 'clover';
    baseUrl: string;
    merchantId: string | null;
    hasToken: boolean;
    hasWebhookSecret: boolean;
    lastVerifiedAt: Date | null;
    updatedAt: Date | null;
  }> {
    const [row] = await this.db
      .select()
      .from(schema.posConfigs)
      .where(eq(schema.posConfigs.storeId, storeId))
      .limit(1);
    if (!row) {
      return {
        configured: false,
        provider: 'clover',
        baseUrl: 'https://sandbox.dev.clover.com',
        merchantId: null,
        hasToken: false,
        hasWebhookSecret: false,
        lastVerifiedAt: null,
        updatedAt: null,
      };
    }
    return {
      configured: true,
      provider: row.provider,
      baseUrl: row.baseUrl,
      merchantId: row.merchantId,
      hasToken: row.accessTokenCiphertext.length > 0,
      hasWebhookSecret: row.webhookSecretCiphertext.length > 0,
      lastVerifiedAt: row.lastVerifiedAt,
      updatedAt: row.updatedAt,
    };
  }

  async upsertPos(input: UpsertPosInput): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(schema.posConfigs)
      .where(eq(schema.posConfigs.storeId, input.storeId))
      .limit(1);

    const tokenBlob = input.accessToken
      ? this.vault.encrypt(input.accessToken)
      : existing
        ? { ciphertext: existing.accessTokenCiphertext, iv: existing.accessTokenIv, tag: existing.accessTokenTag, keyVersion: existing.keyVersion }
        : null;
    const secretBlob = input.webhookSigningSecret
      ? this.vault.encrypt(input.webhookSigningSecret)
      : existing
        ? { ciphertext: existing.webhookSecretCiphertext, iv: existing.webhookSecretIv, tag: existing.webhookSecretTag, keyVersion: existing.keyVersion }
        : null;

    if (!tokenBlob || !secretBlob) {
      throw new Error('accessToken and webhookSigningSecret are required when creating a new POS config');
    }

    // When the user rotates one secret but not the other, the per-row
    // key_version must reflect the OLDEST blob — otherwise readers using a
    // newer key would fail on the stale half.
    const keyVersion = Math.min(tokenBlob.keyVersion, secretBlob.keyVersion);

    if (existing) {
      await this.db
        .update(schema.posConfigs)
        .set({
          baseUrl: input.baseUrl,
          merchantId: input.merchantId,
          accessTokenCiphertext: tokenBlob.ciphertext,
          accessTokenIv: tokenBlob.iv,
          accessTokenTag: tokenBlob.tag,
          webhookSecretCiphertext: secretBlob.ciphertext,
          webhookSecretIv: secretBlob.iv,
          webhookSecretTag: secretBlob.tag,
          keyVersion,
          updatedBy: input.actorId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.posConfigs.storeId, input.storeId));
    } else {
      await this.db.insert(schema.posConfigs).values({
        storeId: input.storeId,
        provider: 'clover',
        baseUrl: input.baseUrl,
        merchantId: input.merchantId,
        accessTokenCiphertext: tokenBlob.ciphertext,
        accessTokenIv: tokenBlob.iv,
        accessTokenTag: tokenBlob.tag,
        webhookSecretCiphertext: secretBlob.ciphertext,
        webhookSecretIv: secretBlob.iv,
        webhookSecretTag: secretBlob.tag,
        keyVersion,
        updatedBy: input.actorId ?? null,
      });
    }

    await this.audit({
      storeId: input.storeId,
      tableName: 'pos_configs',
      action: existing ? 'update' : 'create',
      actorId: input.actorId,
      actorIp: input.actorIp,
    });
    this.posCache.delete(input.storeId);
    if (existing && existing.merchantId !== input.merchantId) {
      this.posByMerchantCache.delete(existing.merchantId);
    }
    this.posByMerchantCache.delete(input.merchantId);
  }

  async markPosVerified(storeId: string, actorId?: string | null, actorIp?: string | null): Promise<void> {
    await this.db
      .update(schema.posConfigs)
      .set({ lastVerifiedAt: new Date() })
      .where(eq(schema.posConfigs.storeId, storeId));
    await this.audit({ storeId, tableName: 'pos_configs', action: 'verify', actorId, actorIp });
  }

  /** Drop in-process caches for one or all stores. */
  invalidate(storeId?: string): void {
    if (!storeId) {
      this.tcgapiCache.clear();
      this.posCache.clear();
      this.posByMerchantCache.clear();
      return;
    }
    this.tcgapiCache.delete(storeId);
    this.posCache.delete(storeId);
    // posByMerchantCache is keyed on merchantId; drop entries pointing at this store.
    for (const [k, v] of this.posByMerchantCache) {
      if (v.value.storeId === storeId) this.posByMerchantCache.delete(k);
    }
  }

  // ---- helpers -------------------------------------------------------------

  private blob(ct: string, iv: string, tag: string, keyVersion: number): EncryptedBlob {
    return { ciphertext: ct, iv, tag, keyVersion };
  }

  private async audit(args: {
    storeId: string;
    tableName: string;
    action: string;
    actorId?: string | null;
    actorIp?: string | null;
  }): Promise<void> {
    await this.db.insert(schema.configAuditLog).values({
      storeId: args.storeId,
      tableName: args.tableName,
      action: args.action,
      actorId: args.actorId ?? null,
      actorIp: args.actorIp ?? null,
    });
  }
}
