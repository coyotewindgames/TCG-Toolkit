import { describe, expect, it } from 'vitest';
import { isFirebaseIdTokenCandidate } from '../src/server/auth/firebase-admin';

function tokenWithAlgorithm(alg: string): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('Firebase authentication migration foundation', () => {
  it('routes RS256 tokens to Firebase verification', () => {
    expect(isFirebaseIdTokenCandidate(tokenWithAlgorithm('RS256'))).toBe(true);
  });

  it('keeps legacy HS256 tokens on the Passport path', () => {
    expect(isFirebaseIdTokenCandidate(tokenWithAlgorithm('HS256'))).toBe(false);
  });

  it('rejects malformed token headers as Firebase candidates', () => {
    expect(isFirebaseIdTokenCandidate('not-a-jwt')).toBe(false);
    expect(isFirebaseIdTokenCandidate('e30.payload.signature')).toBe(false);
  });
});