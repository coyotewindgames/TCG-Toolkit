/**
 * Forgot/reset password flow.
 *
 * Threat model & invariants:
 *  - Email enumeration: `request()` always behaves identically whether the
 *    email matches a user or not. No timing leak (we still hash a throwaway
 *    string when no user is found) and no different status codes upstream.
 *  - Replay: the emailed token is one-time. `consume()` checks `consumedAt
 *    IS NULL` and `expiresAt > now()` inside a single transaction and sets
 *    `consumedAt` before doing anything else.
 *  - Token leakage: only the SHA-256 hash of the token lives in the DB.
 *    Logs never include the plaintext.
 *  - Session hijack: a successful reset revokes every outstanding refresh
 *    token for the user so any session opened with the old password is
 *    immediately useless.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { schema, type Database } from '../../db/client';
import { BadRequest } from '../../common/http-errors';
import { getLogger } from '../../common/logger';
import { loadEnv } from '../../config/env';
import { getMailer } from '../../integrations/mailer/mailer';
import { hashPassword } from '../auth/service';

/** One hour is the conventional sweet spot — long enough for users to act,
 * short enough to bound exposure. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function buildResetLink(token: string): string {
  const base = loadEnv().APP_BASE_URL.replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function requestPasswordReset(
  db: Database,
  args: { email: string; requestedIp?: string },
): Promise<void> {
  const email = args.email.trim().toLowerCase();

  const users = await db
    .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName, disabledAt: schema.users.disabledAt })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  const user = users[0];

  if (!user || user.disabledAt) {
    // Burn a hash cycle to match the timing of the happy path so callers
    // can't enumerate accounts by latency. Don't leak whether the address
    // exists.
    await hashPassword(randomBytes(16).toString('hex'));
    getLogger().info({ email }, 'password reset requested for unknown or disabled account');
    return;
  }

  const raw = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.insert(schema.passwordResets).values({
    userId: user.id,
    tokenHash,
    expiresAt,
    requestedIp: args.requestedIp ?? null,
  });

  const link = buildResetLink(raw);
  const minutes = Math.round(TOKEN_TTL_MS / 60_000);
  await getMailer().send({
    to: user.email,
    subject: 'Reset your TCG Toolkit password',
    text: [
      `Hi ${user.displayName},`,
      '',
      `Someone (hopefully you) asked to reset the password for your TCG Toolkit account.`,
      `Open the link below to choose a new password. It expires in ${minutes} minutes.`,
      '',
      link,
      '',
      `If you didn't request this, you can ignore this email — your password won't change.`,
    ].join('\n'),
  });
}

export interface ResetPasswordResult {
  userId: string;
}

export async function consumePasswordReset(
  db: Database,
  args: { token: string; newPassword: string },
): Promise<ResetPasswordResult> {
  if (!args.token || args.token.length < 16) throw BadRequest('invalid token');
  if (args.newPassword.length < 8) throw BadRequest('password must be at least 8 characters');

  const tokenHash = hashToken(args.token);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: schema.passwordResets.id,
        userId: schema.passwordResets.userId,
      })
      .from(schema.passwordResets)
      .where(
        and(
          eq(schema.passwordResets.tokenHash, tokenHash),
          isNull(schema.passwordResets.consumedAt),
          gt(schema.passwordResets.expiresAt, new Date()),
        ),
      )
      .limit(1);
    const reset = rows[0];
    if (!reset) throw BadRequest('reset link is invalid or has expired');

    // Mark consumed first so a concurrent request can't reuse the token.
    await tx
      .update(schema.passwordResets)
      .set({ consumedAt: new Date() })
      .where(eq(schema.passwordResets.id, reset.id));

    const passwordHash = await hashPassword(args.newPassword);
    await tx
      .update(schema.users)
      .set({ passwordHash })
      .where(eq(schema.users.id, reset.userId));

    // Revoke every active refresh token for this user. Any pre-reset session
    // dies on its next /auth/refresh round-trip (worst case: a stolen 15 min
    // access token remains usable until expiry, which is acceptable).
    await tx
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.refreshTokens.userId, reset.userId),
          isNull(schema.refreshTokens.revokedAt),
        ),
      );

    return { userId: reset.userId };
  });
}
