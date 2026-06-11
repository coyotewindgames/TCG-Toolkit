import { Router } from 'express';
import passport from 'passport';
import rateLimit from 'express-rate-limit';
import { ForgotPasswordRequest, LoginRequest, ResetPasswordRequest, SignupRequest } from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { Unauthorized } from '../../common/http-errors';
import { loadEnv, isProd } from '../../config/env';
import { getDb } from '../../db/client';
import { validateBody } from '../middleware/validate';
import { requireAuth } from './middleware';
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from './service';
import { createStoreWithOwner } from '../services/onboarding-service';
import {
  consumePasswordReset,
  requestPasswordReset,
} from '../services/password-reset-service';
import type { AuthenticatedUser } from './types';

const router = Router();
const env = loadEnv();

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
        res.json({ accessToken: token, expiresIn, user });
      },
    )(req, res, next);
  }),
);

/**
 * Public self-serve signup. Tighter rate limit than login (5 / IP / hour) to
 * curb store-creation abuse — the parent /api/auth router already has a
 * 30 req/min limiter applied; this stacks on top.
 */
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});
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
    });
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const raw = req.cookies?.[env.REFRESH_COOKIE_NAME];
    if (!raw) throw Unauthorized('missing refresh token');
    const { newRaw, user } = await rotateRefreshToken(raw, {
      userAgent: req.header('user-agent') ?? undefined,
      ipAddress: req.ip,
    });
    const { token, expiresIn } = signAccessToken(user);
    setRefreshCookie(res, newRaw);
    res.json({ accessToken: token, expiresIn, user });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const raw = req.cookies?.[env.REFRESH_COOKIE_NAME];
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

export const authRouter = router;
