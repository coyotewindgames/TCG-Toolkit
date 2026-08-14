import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import { Unauthorized } from '../../common/http-errors';
import { loadEnv } from '../../config/env';
import { findUserByFirebaseUid, toAuthenticatedUser } from './service';
import type { AuthenticatedUser } from './types';

let authInstance: Auth | null | undefined;

function normalizedPrivateKey(raw: string): string {
  return raw.replace(/\\n/g, '\n');
}

/**
 * Returns Firebase Auth when configured, otherwise null. Keeping this lazy
 * lets the additive migration deploy before Firebase credentials are present.
 */
export function getFirebaseAuth(): Auth | null {
  if (authInstance !== undefined) return authInstance;

  const env = loadEnv();
  if (!env.FIREBASE_PROJECT_ID) {
    authInstance = null;
    return authInstance;
  }

  if (!getApps().length) {
    const emulator = Boolean(env.FIREBASE_AUTH_EMULATOR_HOST);
    const hasServiceAccount = Boolean(env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
    if (!emulator && !hasServiceAccount) {
      throw new Error(
        'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are required when Firebase Auth is enabled outside the emulator',
      );
    }

    initializeApp({
      projectId: env.FIREBASE_PROJECT_ID,
      ...(hasServiceAccount
        ? {
            credential: cert({
              projectId: env.FIREBASE_PROJECT_ID,
              clientEmail: env.FIREBASE_CLIENT_EMAIL!,
              privateKey: normalizedPrivateKey(env.FIREBASE_PRIVATE_KEY!),
            }),
          }
        : {}),
    });
  }

  authInstance = getAuth();
  return authInstance;
}

export function isFirebaseIdTokenCandidate(token: string): boolean {
  const [header] = token.split('.');
  if (!header) return false;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      alg?: string;
    };
    return decoded.alg === 'RS256';
  } catch {
    return false;
  }
}

export async function verifyFirebaseIdToken(token: string): Promise<DecodedIdToken> {
  const auth = getFirebaseAuth();
  if (!auth) throw Unauthorized('Firebase Authentication is not configured');
  try {
    return await auth.verifyIdToken(token);
  } catch {
    throw Unauthorized('invalid Firebase ID token');
  }
}

export async function authenticateFirebaseToken(token: string): Promise<AuthenticatedUser> {
  const decoded = await verifyFirebaseIdToken(token);
  const user = await findUserByFirebaseUid(decoded.uid);
  if (!user || user.disabledAt) throw Unauthorized('user is not provisioned or is disabled');
  return toAuthenticatedUser(user);
}