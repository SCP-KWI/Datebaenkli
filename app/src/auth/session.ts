/**
 * Server-side sessions, stored in the meta database's `session` table.
 *
 * The cookie carries a 32-byte random token; the table stores only its SHA-256.
 * A stolen database dump (or a `SELECT * FROM session` by anyone who ever gets
 * read access to the meta DB) therefore cannot be replayed as a login. The
 * token has full entropy, so a plain hash is enough — there is nothing to
 * brute-force and no need for a KDF here.
 *
 * Sessions are rolling: a session in active use is extended, an idle one dies
 * on its own. Expired rows are swept periodically rather than at read time, so
 * a full table never accumulates from students who just close the laptop lid.
 */

import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { config } from '../config.js';
import type { Db, Queryable } from '../db/query.js';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'teacher' | 'student';
  state: 'active' | 'archived' | 'cold' | 'deleted';
  locale: string;
  mustChangePassword: boolean;
  pgRole: string | null;
}

export interface LoadedSession {
  user: SessionUser;
  expiresAt: Date;
}

/** Opaque value handed to the browser. Never stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export interface SessionOrigin {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export async function createSession(
  db: Queryable,
  userId: number,
  origin: SessionOrigin = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + config.session.ttlMs);

  await db.query(
    `INSERT INTO session (id, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      tokenKey(token),
      userId,
      expiresAt,
      // `inet` rejects junk; an unparseable forwarded address should not fail a
      // login, so hand Postgres NULL rather than something it will reject.
      origin.ip !== undefined && isIP(origin.ip) !== 0 ? origin.ip : null,
      origin.userAgent?.slice(0, 500) ?? null,
    ],
  );

  return { token, expiresAt };
}

interface SessionRow {
  expires_at: Date;
  id: number;
  username: string;
  display_name: string;
  role: SessionUser['role'];
  state: SessionUser['state'];
  locale: string;
  must_change_password: boolean;
  pg_role: string | null;
}

/**
 * Resolve a cookie token to its user, or null.
 *
 * Deliberately joins rather than doing two queries: a session whose user has
 * since been archived or deleted must stop working immediately, not at the next
 * expiry. `last_active_at` is *not* touched here — that would mean a write on
 * every request; it is updated on login and by the query runner in phase 3.
 */
export async function loadSession(db: Queryable, token: string): Promise<LoadedSession | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT s.expires_at,
            u.id, u.username, u.display_name, u.role, u.state, u.locale,
            u.must_change_password, u.pg_role
       FROM session s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.state = 'active'`,
    [tokenKey(token)],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    expiresAt: row.expires_at,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      state: row.state,
      locale: row.locale,
      mustChangePassword: row.must_change_password,
      pgRole: row.pg_role,
    },
  };
}

/**
 * Extend a session that is more than halfway through its life, up to an
 * absolute ceiling measured from when it was created.
 *
 * The halfway check keeps this to at most one UPDATE per six hours per user
 * instead of one per request, which matters when 25 students are clicking Run
 * every few seconds.
 *
 * **The ceiling is the part that is about security rather than about writes.**
 * Rolling extension with no maximum means a session in continuous use never
 * ages out at all: a token lifted off a shared classroom machine stays valid
 * for as long as it keeps being used, which is indefinitely. `created_at` has
 * been written since the table existed and was never read; this is what reads
 * it.
 *
 * A week, against a 12-hour TTL. It cannot interrupt a lesson — reaching it
 * takes seven days of using the same session without ever logging out — and it
 * lands the re-authentication on a login page rather than mid-query.
 */
export async function refreshSession(
  db: Queryable,
  token: string,
  expiresAt: Date,
): Promise<Date | null> {
  const halfLife = config.session.ttlMs / 2;
  if (expiresAt.getTime() - Date.now() > halfLife) return null;

  const next = new Date(Date.now() + config.session.ttlMs);
  // `LEAST` in SQL rather than a read-then-write: the row is right here, and
  // two round trips would leave a window where a session past the ceiling is
  // extended anyway. A session already past it simply stops being extended and
  // expires on its own — no separate deletion, and the sweeper collects it.
  await db.query(
    `UPDATE session
        SET expires_at = LEAST($2::timestamptz, created_at + $3::interval)
      WHERE id = $1`,
    [tokenKey(token), next, config.session.absoluteTtlMs + ' milliseconds'],
  );
  return next;
}

export async function destroySession(db: Queryable, token: string): Promise<void> {
  await db.query(`DELETE FROM session WHERE id = $1`, [tokenKey(token)]);
}

/**
 * Drop every session of a user. Called on password change and on any state
 * change that should take effect now: a student whose password a teacher has
 * just reset must not keep browsing on the old one.
 */
export async function destroyUserSessions(db: Queryable, userId: number): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `DELETE FROM session WHERE user_id = $1 RETURNING id`,
    [userId],
  );
  return rows.length;
}

export async function sweepExpiredSessions(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `DELETE FROM session WHERE expires_at <= now() RETURNING id`,
  );
  return rows.length;
}

let sweeper: NodeJS.Timeout | undefined;

export function startSessionSweeper(db: Db, log: { warn: (msg: string) => void }): void {
  if (sweeper) return;
  sweeper = setInterval(
    () => {
      sweepExpiredSessions(db).catch((err: unknown) => {
        log.warn(`session sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    15 * 60 * 1000,
  );
  sweeper.unref();
}

export function stopSessionSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = undefined;
}
