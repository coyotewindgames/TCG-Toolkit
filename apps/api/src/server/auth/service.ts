import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, schema } from '../../db/client';
import { loadEnv } from '../../config/env';
import { BadRequest, Unauthorized } from '../../common/http-errors';
import type { AuthenticatedUser } from './types';
import type { UserRole } from '@tcg/shared';

const BCRYPT_ROUNDS = 12;

export interface JwtClaims {
  sub: string; // user id
  sid: string; // store id
  role: UserRole;
  email: string;
  iss: string;
  aud: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function signAccessToken(user: AuthenticatedUser): { token: string; expiresIn: number } {
  const env = loadEnv();
  const claims: Omit<JwtClaims, 'iss' | 'aud'> = {
    sub: user.id,
    sid: user.storeId,
    role: user.role,
    email: user.email,
  };
  const opts: SignOptions = {
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    algorithm: 'HS256',
  };
  const token = jwt.sign(claims, env.JWT_SECRET, opts);
  return { token, expiresIn: env.JWT_ACCESS_TTL_SECONDS };
}

export function verifyAccessToken(token: string): JwtClaims {
  const env = loadEnv();
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    }) as JwtClaims;
    return decoded;
  } catch (err) {
    throw Unauthorized(`invalid token: ${(err as Error).message}`);
  }
}

/** Generate an opaque refresh token; the hashed form is stored in DB. */
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function findUserByEmail(email: string) {
  const db = getDb();
  const rows = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return rows[0] ?? null;
}

export async function findUserById(id: string) {
  const db = getDb();
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return rows[0] ?? null;
}

export function toAuthenticatedUser(row: typeof schema.users.$inferSelect): AuthenticatedUser {
  return {
    id: row.id,
    storeId: row.storeId,
    role: row.role,
    email: row.email,
    displayName: row.displayName,
  };
}

export async function authenticateLocal(
  email: string,
  password: string,
): Promise<AuthenticatedUser> {
  if (!email || !password) throw BadRequest('email and password required');
  const user = await findUserByEmail(email.toLowerCase());
  if (!user || user.disabledAt) throw Unauthorized('invalid credentials');
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw Unauthorized('invalid credentials');
  return toAuthenticatedUser(user);
}

export async function issueRefreshToken(args: {
  userId: string;
  userAgent?: string;
  ipAddress?: string;
}): Promise<string> {
  const env = loadEnv();
  const { raw, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 3600 * 1000);
  await getDb().insert(schema.refreshTokens).values({
    userId: args.userId,
    tokenHash: hash,
    expiresAt,
    userAgent: args.userAgent ?? null,
    ipAddress: args.ipAddress ?? null,
  });
  return raw;
}

export async function rotateRefreshToken(raw: string, meta: { userAgent?: string; ipAddress?: string }) {
  const db = getDb();
  const hash = hashRefreshToken(raw);
  const rows = await db
    .select()
    .from(schema.refreshTokens)
    .where(
      and(
        eq(schema.refreshTokens.tokenHash, hash),
        isNull(schema.refreshTokens.revokedAt),
        gt(schema.refreshTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) throw Unauthorized('invalid refresh token');

  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.refreshTokens.id, existing.id));

  const user = await findUserById(existing.userId);
  if (!user || user.disabledAt) throw Unauthorized('user disabled');

  const newRaw = await issueRefreshToken({
    userId: existing.userId,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  });
  return { newRaw, user: toAuthenticatedUser(user) };
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  const hash = hashRefreshToken(raw);
  await getDb()
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.refreshTokens.tokenHash, hash));
}
