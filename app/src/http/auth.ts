/**
 * Cookie authentication and role guards.
 *
 * Two global hooks do the work:
 *
 *   onRequest   — resolve the session cookie into `req.auth` (or null).
 *   preHandler  — deny anything not marked `public`, and deny *everything* to a
 *                 user who still owes a password change except the handful of
 *                 routes needed to make that change.
 *
 * Making the password gate a global default rather than a per-route opt-in is
 * deliberate: a route added later without thinking about it is closed, not
 * open. The same reasoning applies to authentication itself.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/query.js';
import { loadSession, refreshSession, type SessionUser } from '../auth/session.js';
import type { AppRole } from '../services/users.js';
import { forbidden, unauthorized } from './errors.js';

export interface AuthContext {
  user: SessionUser;
  token: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    /** Reachable without a session (login, health, static assets). */
    public?: boolean;
    /** Reachable while `must_change_password` is still set. */
    passwordChangeExempt?: boolean;
  }
}

const COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: config.session.secure,
  signed: true,
} as const;

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(config.session.cookieName, token, { ...COOKIE_OPTIONS, expires: expiresAt });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.session.cookieName, { ...COOKIE_OPTIONS });
}

function readToken(req: FastifyRequest): string | null {
  const raw = req.cookies[config.session.cookieName];
  if (raw === undefined) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value !== null ? unsigned.value : null;
}

export function registerAuthHooks(app: FastifyInstance, db: Db): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    const token = readToken(req);
    if (token === null) return;

    let session: Awaited<ReturnType<typeof loadSession>>;
    try {
      session = await loadSession(db, token);
    } catch (err) {
      // The database is unreachable. Letting this propagate would 500 *every*
      // route for anyone holding a cookie — including /health, which exists to
      // report the outage, and /login, which is where they would go next. Fall
      // through as unauthenticated instead: /api routes answer 401 and the
      // pages render.
      //
      // Deliberately does NOT clear the cookie: the session is not known to be
      // invalid, only unverifiable, so it must still work once the database is
      // back rather than forcing everyone to log in again.
      req.log.error({ err }, 'session lookup failed; treating request as unauthenticated');
      return;
    }

    if (!session) {
      // Expired, revoked, or the account was archived. Drop the stale cookie so
      // the browser stops sending it and the user sees the login page.
      clearSessionCookie(reply);
      return;
    }

    req.auth = { user: session.user, token };

    const extended = await refreshSession(db, token, session.expiresAt).catch((err: unknown) => {
      // Same reasoning: failing to *extend* a session is not a reason to fail
      // the request the user actually made.
      req.log.warn({ err }, 'session refresh failed');
      return null;
    });
    if (extended) setSessionCookie(reply, token, extended);
  });

  app.addHook('preHandler', async (req) => {
    // No route matched — there is nothing behind this URL to protect, and
    // answering 401 would make a typo look like a permissions problem. Let the
    // not-found handler have it. (`is404` is Fastify's own contract for this;
    // `routeOptions.url === undefined` derives the same thing from an accessor
    // that rebuilds an object on every access.)
    if (req.is404) return;

    const routeConfig = req.routeOptions.config;
    if (routeConfig.public) return;

    if (!req.auth) throw unauthorized();

    if (req.auth.user.mustChangePassword && !routeConfig.passwordChangeExempt) {
      throw forbidden(
        'password_change_required',
        'Set a new password before using the rest of the application.',
      );
    }
  });
}

/** The signed-in user, or 401. Use in handlers where the global hook guarantees one. */
export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}

/** Route-level `preHandler` restricting a route to the given app roles. */
export function requireRole(...roles: AppRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const user = currentUser(req);
    if (!roles.includes(user.role)) {
      throw forbidden('wrong_role', `This action requires: ${roles.join(' or ')}.`);
    }
  };
}
