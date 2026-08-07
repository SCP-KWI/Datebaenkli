/**
 * Login, logout, and the routes a user needs while still locked behind a forced
 * password change.
 */

import type { FastifyInstance } from 'fastify';
import { accountLimiter, ipHardLimiter, ipLimiter } from '../auth/ratelimit.js';
import { config } from '../config.js';
import { createSession, destroySession, destroyUserSessions } from '../auth/session.js';
import type { Db } from '../db/query.js';
import { clearSessionCookie, currentUser, setSessionCookie } from '../http/auth.js';
import { HttpError, unauthorized } from '../http/errors.js';
import { asObject, maybe, optionalStr, rawStr, str } from '../http/validate.js';
import {
  authenticate,
  changeOwnPassword,
  getUser,
  ServiceError,
  updateProfile,
} from '../services/users.js';

export function registerSessionRoutes(app: FastifyInstance, db: Db): void {
  app.post('/api/login', { config: { public: true } }, async (req, reply) => {
    const body = asObject(req.body);
    const username = str(body, 'username', { max: 63 });
    const password = rawStr(body, 'password');

    const accountKey = username.toLowerCase();
    const wait = Math.max(
      ipLimiter.retryAfterMs(req.ip),
      ipHardLimiter.retryAfterMs(req.ip),
      accountLimiter.retryAfterMs(accountKey),
    );
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      void reply.header('Retry-After', String(seconds));
      throw new HttpError(
        429,
        'too_many_attempts',
        `Too many failed attempts. Try again in ${seconds} seconds.`,
      );
    }

    const user = await authenticate(db, username, password);
    if (!user) {
      ipLimiter.fail(req.ip);
      ipHardLimiter.fail(req.ip);
      accountLimiter.fail(accountKey);
      // One message for every failure mode — a distinct "no such user" would
      // confirm which of a class's guessable usernames exist.
      throw unauthorized('invalid_credentials', 'Username or password is not correct.');
    }

    // Both *clearable* budgets: one typo before a correct login should not
    // linger, and a classroom of 25 sharing a NAT address must not accumulate
    // its way into a shared lockout over a lesson.
    //
    // `ipHardLimiter` is deliberately absent. Clearing on success is exactly
    // what made the per-IP budget bypassable — every student holds a valid
    // account, so one login of their own every 199 failures reset it forever.
    accountLimiter.clear(accountKey);
    ipLimiter.clear(req.ip);

    const { token, expiresAt } = await createSession(db, user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setSessionCookie(reply, token, expiresAt);

    return { user };
  });

  // Public and idempotent: logging out should work even from a dead session,
  // and it must always end with the cookie gone.
  app.post('/api/logout', { config: { public: true } }, async (req, reply) => {
    if (req.auth) await destroySession(db, req.auth.token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  /**
   * `app.publicUrl` is not about the user, and sits beside `user` rather than
   * inside it for that reason. It is here because this is the one response
   * every page already fetches on boot, and a second route for one string is
   * worse than a slightly wider one.
   *
   * The roster's credential slips are what need it. The obvious source for
   * "where is this app" is `location.host`, and that is wrong: it records
   * however the *teacher* happened to reach the page — a dev port, the
   * server's LAN address behind the proxy — onto paper handed to a student,
   * permanently. `config.publicUrl` is the configured answer, already validated
   * at import and already load-bearing (it decides whether cookies are
   * `__Host-`/`Secure`), so a slip and a cookie can never disagree about what
   * this deployment is called.
   */
  app.get('/api/me', { config: { passwordChangeExempt: true } }, async (req) => {
    const session = currentUser(req);
    const user = await getUser(db, session.id);
    if (!user) throw unauthorized();
    return { user, app: { publicUrl: config.publicUrl } };
  });

  /**
   * What build is running, for the footer on every page.
   *
   * **Public, and a route of its own rather than another field on `/api/me`**,
   * which is the opposite of the call made for `publicUrl` above — so the
   * difference is worth stating. `publicUrl` is only ever needed by the roster,
   * which is behind authentication anyway. This is needed by `login.html`,
   * which by definition has no session, and gating it would leave the one page
   * a confused user is most likely to be looking at as the only page that
   * cannot say what it is running.
   *
   * Public is also simply correct, for the reason `/assets` is: a version and a
   * build time are facts about the deployment, not about anyone using it. It
   * tells an unauthenticated caller nothing they could not learn by comparing
   * the served JavaScript against a public repo.
   *
   * `builtAt` is null under `npm run dev`, where there is no build to stamp.
   */
  app.get('/api/version', { config: { public: true } }, async () => config.build);

  app.post('/api/me/password', { config: { passwordChangeExempt: true } }, async (req, reply) => {
    const session = currentUser(req);
    const body = asObject(req.body);

    // Budgeted like a login, and for two reasons. It verifies the *current*
    // password, so without this it is an unmetered oracle for guessing it —
    // useful to someone who has borrowed an unlocked classroom machine and
    // wants the password rather than just the session. And it is the most
    // expensive route in the app: up to two scrypt verifies plus a hash, which
    // an authenticated caller could otherwise loop to starve the threadpool.
    // (`auth/password.ts` bounds the concurrency; this bounds the rate.)
    //
    // Keyed on the account id, not the username: the caller is already
    // authenticated, and the id is the thing that cannot be varied to mint a
    // fresh bucket.
    const passwordKey = `pw:${session.id}`;
    const wait = accountLimiter.retryAfterMs(passwordKey);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      void reply.header('Retry-After', String(seconds));
      throw new HttpError(
        429,
        'too_many_attempts',
        `Too many failed attempts. Try again in ${seconds} seconds.`,
      );
    }
    try {
      await changeOwnPassword(
        db,
        session.id,
        rawStr(body, 'currentPassword'),
        rawStr(body, 'newPassword'),
      );
    } catch (err) {
      // Only a wrong *current* password counts. A rejected new one — too short,
      // same as the old — is an honest mistake by someone who already proved who
      // they are, and locking them out of the page they were sent to would be
      // its own outage.
      if (err instanceof ServiceError && err.code === 'wrong_password') {
        accountLimiter.fail(passwordKey);
      }
      throw err;
    }
    accountLimiter.clear(passwordKey);

    // changeOwnPassword drops every session, including this one — deliberately,
    // so a shared classroom machine does not stay logged in. Issue a fresh
    // session for the browser that just did the change.
    const { token, expiresAt } = await createSession(db, session.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setSessionCookie(reply, token, expiresAt);

    const user = await getUser(db, session.id);
    return { user };
  });

  app.patch('/api/me', async (req) => {
    const session = currentUser(req);
    const body = asObject(req.body);
    const user = await updateProfile(db, session.id, {
      ...maybe('locale', optionalStr(body, 'locale', { max: 8 })),
      ...maybe('displayName', optionalStr(body, 'displayName', { max: 120 })),
    });
    return { user };
  });

  /** Log this account out everywhere — the "I left it open in the lab" button. */
  app.post('/api/me/sessions/revoke', { config: { passwordChangeExempt: true } }, async (req, reply) => {
    const session = currentUser(req);
    const count = await destroyUserSessions(db, session.id);
    clearSessionCookie(reply);
    return { revoked: count };
  });
}
