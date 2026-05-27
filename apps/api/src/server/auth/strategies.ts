import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { loadEnv } from '../../config/env';
import {
  authenticateLocal,
  findUserById,
  toAuthenticatedUser,
  type JwtClaims,
} from './service';

/**
 * Configure Passport strategies. Called once during boot.
 *
 * We deliberately keep Passport's stateful `req.login` machinery out of the
 * picture — strategies authenticate, and we issue our own JWTs from the route
 * handler.
 */
export function configurePassport(): void {
  const env = loadEnv();

  passport.use(
    new LocalStrategy(
      { usernameField: 'email', passwordField: 'password', session: false },
      async (email, password, done) => {
        try {
          const user = await authenticateLocal(email, password);
          done(null, user);
        } catch (err) {
          done(null, false, { message: (err as Error).message });
        }
      },
    ),
  );

  passport.use(
    new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: env.JWT_SECRET,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        algorithms: ['HS256'],
      },
      async (payload: JwtClaims, done) => {
        try {
          const user = await findUserById(payload.sub);
          if (!user || user.disabledAt) return done(null, false);
          done(null, toAuthenticatedUser(user));
        } catch (err) {
          done(err as Error, false);
        }
      },
    ),
  );
}
