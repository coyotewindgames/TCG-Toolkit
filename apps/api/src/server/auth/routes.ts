import { Router } from 'express';
import passport from 'passport';
import { LoginRequest } from '@tcg/shared';
import { asyncHandler } from '../../common/async-handler';
import { Unauthorized } from '../../common/http-errors';
import { loadEnv, isProd } from '../../config/env';
import { validateBody } from '../middleware/validate';
import { requireAuth } from './middleware';
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from './service';
import type { AuthenticatedUser } from './types';

const router = Router();
const env = loadEnv();

function setRefreshCookie(res: import('express').Response, raw: string) {
  const maxAge = env.REFRESH_TTL_DAYS * 24 * 3600 * 1000;
  res.cookie(env.REFRESH_COOKIE_NAME, raw, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
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

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export const authRouter = router;
