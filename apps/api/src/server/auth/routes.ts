import { Router } from 'express';
import passport from 'passport';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { FirebaseProvisionRequest, ForgotPasswordRequest, LoginRequest, LogoutRequest, RefreshRequest, ResetPasswordRequest, SignupRequest } from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { BadRequest, Unauthorized } from '../../common/http-errors';
import { loadEnv, isProd } from '../../config/env';
import { getDb, schema } from '../../db/client';
import { validateBody } from '../middleware/validate';
import { requireAuth } from './middleware';
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  findUserByFirebaseUid,
  toAuthenticatedUser,
} from './service';
import { createStoreWithFirebaseOwner, createStoreWithOwner } from '../services/onboarding-service';
import { verifyFirebaseIdToken } from './firebase-admin';
import {
  consumePasswordReset,
  requestPasswordReset,
} from '../services/password-reset-service';
import type { AuthenticatedUser } from './types';

const router = Router();
const env = loadEnv();

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

function bearerToken(req: import('express').Request): string {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw Unauthorized('missing Firebase ID token');
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw Unauthorized('missing Firebase ID token');
  return token;
}

function setRefreshCookie(res: import('express').Response, raw: string) {
  const maxAge = env.REFRESH_TTL_DAYS * 24 * 3600 * 1000;
  res.cookie(env.REFRESH_COOKIE_NAME, raw, {
    httpOnly: true,
    secure: isProd(),
    sameSite: isProd() ? 'none' : 'lax',
    domain: env.COOKIE_DOMAIN,
    maxAge,
    path: '/api/auth',
  });
}

function clearRefreshCookie(res: import('express').Response) {
  res.clearCookie(env.REFRESH_COOKIE_NAME, {
    domain: env.COOKIE_DOMAIN,
    path: '/api/auth',
  });
}

/** Returns true when the request originates from a Capacitor native shell. */
function isNativeRequest(req: import('express').Request): boolean {
  return req.headers['x-client-platform'] === 'capacitor';
}

/** Resolves the raw refresh token from the HttpOnly cookie or request body. */
function resolveRefreshToken(req: import('express').Request): string | undefined {
  return req.cookies?.[env.REFRESH_COOKIE_NAME]
    ?? (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined);
}

router.post(
  '/login',
  validateBody(LoginRequest),
  asyncHandler((req, res, next) => {
    passport.authenticate(
      'local',
      { session: false },
      async (err: Error | null, user: AuthenticatedUser | false) => {
        if (err) return next(err);
        if (!user) return next(Unauthorized('invalid credentials'));

        const { token, expiresIn } = signAccessToken(user);
        const refresh = await issueRefreshToken({
          userId: user.id,
          userAgent: req.header('user-agent') ?? undefined,
          ipAddress: req.ip,
        });
        setRefreshCookie(res, refresh);
        res.json({
          accessToken: token,
          expiresIn,
          user,
          ...(isNativeRequest(req) ? { refreshToken: refresh } : {}),
        });
      },
    )(req, res, next);
  }),
);

/**
 * Creates the Postgres tenant/profile for a newly authenticated Firebase
 * owner. Repeating the request for an already provisioned UID is safe.
 */
router.post(
  '/provision',
  signupLimiter,
  validateBody(FirebaseProvisionRequest),
  asyncHandler(async (req, res) => {
    const decoded = await verifyFirebaseIdToken(bearerToken(req));
    const existing = await findUserByFirebaseUid(decoded.uid);
    if (existing) {
      const [store] = await getDb()
        .select({ id: schema.stores.id, name: schema.stores.name })
        .from(schema.stores)
        .where(eq(schema.stores.id, existing.storeId))
        .limit(1);
      const [location] = await getDb()
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.locations)
        .where(eq(schema.locations.storeId, existing.storeId))
        .limit(1);
      return res.json({ user: toAuthenticatedUser(existing), store, location });
    }

    const email = decoded.email?.trim().toLowerCase();
    if (!email) throw BadRequest('Firebase account must have an email address');
    const body = req.body as FirebaseProvisionRequest;
    const created = await createStoreWithFirebaseOwner(getDb(), {
      firebaseUid: decoded.uid,
      ownerEmail: email,
      ownerName: body.ownerName || decoded.name || email,
      storeName: body.storeName,
      timezone: body.timezone,
      locationName: body.locationName,
    });
    return res.status(201).json({
      user: created.owner,
      store: created.store,
      location: created.location,
    });
  }),
);

/**
 * Public self-serve signup. Tighter rate limit than login (5 / IP / hour) to
 * curb store-creation abuse — the parent /api/auth router already has a
 * 30 req/min limiter applied; this stacks on top.
 */
router.post(
  '/signup',
  signupLimiter,
  validateBody(SignupRequest),
  asyncHandler(async (req, res) => {
    const body = req.body as SignupRequest;
    const created = await createStoreWithOwner(getDb(), {
      storeName: body.storeName,
      ownerEmail: body.ownerEmail,
      ownerPassword: body.ownerPassword,
      ownerName: body.ownerName,
      timezone: body.timezone,
      locationName: body.locationName,
    });
    const { token, expiresIn } = signAccessToken(created.owner);
    const refresh = await issueRefreshToken({
      userId: created.owner.id,
      userAgent: req.header('user-agent') ?? undefined,
      ipAddress: req.ip,
    });
    setRefreshCookie(res, refresh);
    res.status(201).json({
      accessToken: token,
      expiresIn,
      user: created.owner,
      store: created.store,
      location: created.location,
      ...(isNativeRequest(req) ? { refreshToken: refresh } : {}),
    });
  }),
);

router.post(
  '/refresh',
  validateBody(RefreshRequest),
  asyncHandler(async (req, res) => {
    const raw = resolveRefreshToken(req);
    if (!raw) throw Unauthorized('missing refresh token');
    const { newRaw, user } = await rotateRefreshToken(raw, {
      userAgent: req.header('user-agent') ?? undefined,
      ipAddress: req.ip,
    });
    const { token, expiresIn } = signAccessToken(user);
    setRefreshCookie(res, newRaw);
    res.json({
      accessToken: token,
      expiresIn,
      user,
      ...(isNativeRequest(req) ? { refreshToken: newRaw } : {}),
    });
  }),
);

router.post(
  '/logout',
  validateBody(LogoutRequest),
  asyncHandler(async (req, res) => {
    const raw = resolveRefreshToken(req);
    if (raw) await revokeRefreshToken(raw);
    clearRefreshCookie(res);
    res.json({ ok: true });
  }),
);

/**
 * Forgot-password: always returns 204 regardless of whether the email
 * matched a user, to prevent account enumeration. Tightly rate limited
 * because a single email costs a Resend send.
 */
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});
router.post(
  '/forgot-password',
  forgotLimiter,
  validateBody(ForgotPasswordRequest),
  asyncHandler(async (req, res) => {
    const body = req.body as ForgotPasswordRequest;
    await requestPasswordReset(getDb(), { email: body.email, requestedIp: req.ip });
    res.status(204).end();
  }),
);

/**
 * Reset-password: consumes a one-time token + sets a new password. Also
 * revokes every active refresh token for the user (handled inside the
 * service) so any open session is invalidated.
 */
router.post(
  '/reset-password',
  validateBody(ResetPasswordRequest),
  asyncHandler(async (req, res) => {
    const body = req.body as ResetPasswordRequest;
    await consumePasswordReset(getDb(), {
      token: body.token,
      newPassword: body.password,
    });
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/**
 * Email availability check for the signup form.
 * Returns { available: boolean } — does NOT confirm whether the email
 * exists (anti-enumeration: the check is best-effort UX only).
 * Tight rate limit: 20 checks per IP per 15 minutes.
 */
const checkEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
router.get(
  '/check-email',
  checkEmailLimiter,
  asyncHandler(async (req, res) => {
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query param required' });
    const rows = await getDb()
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    res.json({ available: rows.length === 0 });
  }),
);

export const authRouter = router;
