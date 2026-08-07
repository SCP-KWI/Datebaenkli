/**
 * Environment configuration.
 *
 * Validated eagerly at import time: a missing or malformed secret should crash
 * the container on boot, loudly, rather than surface as a confusing 500 during
 * a lesson.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const missing: string[] = [];

/**
 * What is running, for the page footer and for a support question.
 *
 * Two halves with deliberately different guarantees. **`version`** is
 * `package.json`'s and is bumped by hand at release; `package.json` sits one
 * level above both `src/` and `dist/`, so the same relative path works whether
 * this file is being executed from source or from the build. **`builtAt`** is
 * written by `tools/stamp-build.mjs` during `postbuild` and cannot be
 * forgotten.
 *
 * Pairing them is the point: a semver alone went unbumped through seven phases,
 * so it would have named the wrong release with nothing to contradict it. With
 * a timestamp beside it, a stale version is uninformative rather than a lie.
 *
 * **`builtAt: null` means "not a build", and that is a fact rather than a
 * failure.** `npm run dev` runs from `src/` where no `dist/build-info.json`
 * exists, so the footer says so. Both reads are wrapped because neither is
 * worth refusing to boot over — this is the one value in this file whose
 * absence should not crash a container, since nothing depends on it.
 */
function readBuildInfo(): { version: string; builtAt: string | null } {
  const read = <T>(path: string, pick: (parsed: Record<string, unknown>) => T, fallback: T): T => {
    try {
      return pick(JSON.parse(readFileSync(join(import.meta.dirname, path), 'utf8')));
    } catch {
      return fallback;
    }
  };
  return {
    version: read('../package.json', (p) => String(p.version ?? '0.0.0'), '0.0.0'),
    // Resolved next to this module, not to the repo: it only exists in `dist`.
    builtAt: read('./build-info.json', (p) => (p.builtAt ? String(p.builtAt) : null), null),
  };
}

const build = readBuildInfo();

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    missing.push(name);
    return '';
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v;
}

function int(
  name: string,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(
      max === Number.MAX_SAFE_INTEGER
        ? `${name} must be an integer >= ${min}, got: ${raw}`
        : `${name} must be an integer between ${min} and ${max}, got: ${raw}`,
    );
  }
  return n;
}

/** Postgres interval-ish string, e.g. "15s". Rejects anything we'd have to interpolate blindly. */
function duration(name: string, fallback: string): string {
  const v = optional(name, fallback);
  if (!/^\d+(ms|s|min)$/.test(v)) {
    throw new Error(`${name} must look like "15s", "500ms" or "2min", got: ${v}`);
  }
  return v;
}

/**
 * Postgres memory-size string, e.g. "8MB".
 *
 * Same reason as `duration`: these end up interpolated into
 * `ALTER ROLE ... SET work_mem = '...'`, which takes no bind parameter, so the
 * shape is checked here rather than trusted.
 */
function size(name: string, fallback: string): string {
  const v = optional(name, fallback);
  if (!/^\d+(kB|MB|GB)$/.test(v)) {
    throw new Error(`${name} must look like "8MB" or "512kB", got: ${v}`);
  }
  return v;
}

/** The same value as milliseconds, for timers on our side of the connection. */
function durationToMs(v: string): number {
  const m = /^(\d+)(ms|s|min)$/.exec(v);
  if (m?.[1] === undefined) {
    throw new Error(`${v} is not a duration — duration() should have rejected it already.`);
  }
  const scale = m[2] === 'ms' ? 1 : m[2] === 'min' ? 60_000 : 1_000;
  return Number(m[1]) * scale;
}

function bool(name: string, fallback: boolean): boolean {
  const v = optional(name, fallback ? 'true' : 'false');
  if (v !== 'true' && v !== 'false') {
    throw new Error(`${name} must be "true" or "false", got: ${v}`);
  }
  return v === 'true';
}

const encryptionKeyRaw = required('DBK_ENCRYPTION_KEY');
let encryptionKey = Buffer.alloc(0);
if (encryptionKeyRaw) {
  encryptionKey = Buffer.from(encryptionKeyRaw, 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error(
      `DBK_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${encryptionKey.length}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
}

const sessionSecret = required('DBK_SESSION_SECRET');
if (sessionSecret && sessionSecret.length < 32) {
  throw new Error('DBK_SESSION_SECRET must be at least 32 characters.');
}
// Length alone is not strength: `'a'.repeat(32)` passed the check above, and
// the realistic way that happens is someone filling `.env` in a hurry to get a
// bring-up finished. A distinct-character count is a crude proxy for entropy
// and it is the *right* crudeness here — it cannot reject a real generated
// secret (32 random base64 characters have ~24 distinct ones, and the odds of
// fewer than 12 are vanishing) while it does reject every keyboard-mash and
// repeated-character value. `DBK_ENCRYPTION_KEY` needs no equivalent: it is
// already pinned to exactly 32 decoded bytes and there is no short-but-valid
// form of it.
if (sessionSecret && new Set(sessionSecret).size < 12) {
  throw new Error(
    `DBK_SESSION_SECRET has only ${new Set(sessionSecret).size} distinct characters, which is ` +
      `not a generated secret. Make one with: openssl rand -hex 32`,
  );
}

/**
 * Whether to mark the session cookie `Secure` — and, with it, whether to use
 * the `__Host-` cookie name prefix.
 *
 * Derived from the public URL's scheme rather than from NODE_ENV. NODE_ENV is
 * `production` in the container from the very first `docker compose up`, but
 * HANDOFF §5 deliberately brings the reverse-proxy host up *without* TLS first and
 * adds the certificate afterwards. Keying off NODE_ENV would make login appear
 * to succeed and then silently fail during exactly that step: the server sets a
 * Secure cookie, the browser refuses to store it over plain http, and the next
 * request is a 401 with nothing in the logs to explain it.
 *
 * `DBK_COOKIE_SECURE` overrides, for a deployment that terminates TLS somewhere
 * the app cannot infer.
 */
/** Pulled out of the object below because the watchdog's default is derived from it. */
const statementTimeout = duration('DBK_STATEMENT_TIMEOUT', '15s');
const statementTimeoutMs = durationToMs(statementTimeout);

const publicUrl = optional('DBK_PUBLIC_URL', 'http://localhost:3000');
const cookieSecureRaw = optional('DBK_COOKIE_SECURE', '');
if (cookieSecureRaw !== '' && cookieSecureRaw !== 'true' && cookieSecureRaw !== 'false') {
  throw new Error(`DBK_COOKIE_SECURE must be "true" or "false", got: ${cookieSecureRaw}`);
}
const cookieSecure =
  cookieSecureRaw === '' ? publicUrl.startsWith('https://') : cookieSecureRaw === 'true';

/**
 * Say so, loudly, when a production instance ends up without a Secure cookie.
 *
 * The derivation above is the right one and the comment explains why, but it
 * has a silent failure: `DBK_PUBLIC_URL` unset *or blank* falls back to
 * `http://localhost:3000`, so `cookieSecure` becomes false and the session
 * cookie loses both `Secure` and the `__Host-` prefix with nothing to show for
 * it. `docker-compose.yml` supplies a default so production is covered today —
 * this is about the day someone edits that line.
 *
 * A warning rather than a throw, because the TLS-less first bring-up in
 * HANDOFF §5 is a real supported state and refusing to boot would break it.
 * Written to stderr rather than the app logger: `config.ts` is imported before
 * the logger exists, which is the whole point of validating at import.
 */
if (optional('NODE_ENV', 'development') === 'production' && !cookieSecure) {
  console.warn(
    '[config] WARNING: NODE_ENV=production but the session cookie is NOT Secure ' +
      `(DBK_PUBLIC_URL=${publicUrl || '<empty>'}, DBK_COOKIE_SECURE=${cookieSecureRaw || '<unset>'}). ` +
      'Session tokens will travel in the clear. Expected during the TLS-less bring-up only.',
  );
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',
  port: int('PORT', 3000),
  publicUrl,
  build,

  pg: {
    host: optional('PGHOST', '127.0.0.1'),
    port: int('PGPORT', 5432),
    user: optional('DBK_APP_DB_USER', 'dbk_app'),
    password: required('DBK_APP_DB_PASSWORD'),
    metaDb: optional('DBK_META_DB', 'datebaenkli_meta'),
    teachDb: optional('DBK_TEACH_DB', 'datebaenkli'),
  },

  secrets: {
    session: sessionSecret,
    /** 32 raw bytes for AES-256-GCM. */
    encryptionKey,
  },

  limits: {
    studentQuotaMb: int('DBK_STUDENT_QUOTA_MB', 50),
    statementTimeout,
    /**
     * The watchdog's wall-clock budget for one execution (services/watchdog.ts).
     *
     * Deliberately *longer* than `statementTimeout`, not equal to it. The role
     * default is USERSET and therefore not a boundary, but for the student who
     * has not disabled it it is the cheaper limit — Postgres stops the query
     * itself, with no round trip and a clearer message. This one is the limit
     * that actually holds, so it only needs to fire for the student who lifted
     * the other one.
     */
    queryTimeoutMs: int('DBK_QUERY_TIMEOUT_MS', statementTimeoutMs + 5_000),
    /** Grace between `pg_cancel_backend` and `pg_terminate_backend`. */
    cancelGraceMs: int('DBK_CANCEL_GRACE_MS', 3_000),
    idleInTransactionTimeout: duration('DBK_IDLE_TX_TIMEOUT', '60s'),
    workMem: size('DBK_WORK_MEM', '8MB'),
    maxResultRows: int('DBK_MAX_RESULT_ROWS', 1000),
    /**
     * How long `query_log` keeps a student's SQL text. One school term.
     *
     * The lesson view reads the current session's last 50 statements, so
     * nothing in the app wants an older row — but the table kept every one
     * forever, which made it a growing record of what each student typed,
     * carried into every backup.
     */
    queryLogRetentionDays: int('DBK_QUERY_LOG_RETENTION_DAYS', 120, { min: 1 }),
    /**
     * A byte ceiling on everything one script keeps, alongside the row cap.
     *
     * The two bound different things and neither implies the other: 1000 rows
     * of `repeat('x', 100000000)` is twenty cells and two gigabytes. 16 MB is
     * far more than any lesson produces — the widest realistic grid is a few
     * hundred KB — and small enough that a dozen students hitting it at once
     * cannot exhaust the heap.
     */
    maxResultBytes: int('DBK_MAX_RESULT_BYTES', 16 * 1024 * 1024),
    /** Per-student Postgres connections. Must stay <= the role's CONNECTION LIMIT. */
    poolMaxPerUser: int('DBK_POOL_MAX_PER_USER', 2),
    /** Evict an idle student pool after this long, to free backends between lessons. */
    poolIdleMs: int('DBK_POOL_IDLE_MS', 60_000),
    /**
     * `CONNECTION LIMIT` on every provisioned role. Unlike statement_timeout
     * this one is a real boundary — raising it needs CREATEROLE — so it is the
     * backstop against a student opening connections until the cluster is full.
     */
    roleConnectionLimit: int('DBK_ROLE_CONNECTION_LIMIT', 4),
  },

  provisioning: {
    /**
     * Reconcile `app_user` against `pg_roles` during startup.
     *
     * On by default because it is what makes a crashed provisioning run
     * self-healing: a restart creates whatever is missing. Turn it off to boot
     * quickly against a large instance, then run POST /api/admin/reconcile.
     */
    onBoot: bool('DBK_RECONCILE_ON_BOOT', true),
    /** `pg_dump` binary. The image installs postgresql17-client for this. */
    pgDump: optional('DBK_PG_DUMP', 'pg_dump'),
    /** Its other half, from the same package. Phase 5b's `cold -> active`. */
    pgRestore: optional('DBK_PG_RESTORE', 'pg_restore'),
    /** A dump of a 50 MB schema is seconds; this only catches a wedged server. */
    dumpTimeoutMs: int('DBK_DUMP_TIMEOUT_MS', 300_000),
  },

  /**
   * The account lifecycle (architecture §8b, phase 5b).
   *
   * `archive_after_days` was seeded into the `setting` table by migration 001
   * and read by nobody. It lives here instead, and 002 deletes that row — see
   * the argument in the migration. The short version: this value decides
   * whether a job takes accounts away from students, and everything else that
   * load-bearing is validated at import and crashes the container for a bad
   * value rather than being discovered at 03:40 by the job acting on it.
   */
  lifecycle: {
    /**
     * Idle days before `active -> archived`. Architecture §8b says one year.
     *
     * The floor is 30 rather than 1: this is the input to a job that takes
     * logins away in bulk, and a fat-fingered `1` over a summer holiday would
     * archive an entire school. Thirty days is still absurd for a school year
     * and is the smallest number that cannot be a typo for a sensible one.
     */
    archiveAfterDays: int('DBK_ARCHIVE_AFTER_DAYS', 365, { min: 30 }),
    /** Turn the nightly sweep off entirely. On by default; §8b wants it. */
    sweepEnabled: bool('DBK_ARCHIVE_SWEEP', true),
    /**
     * Local wall-clock time of the nightly sweep, default 03:40.
     *
     * After `db/backup.sh`'s 03:17 in the host crontab, deliberately: that
     * night's backup then holds the *pre*-sweep state, so a sweep that turns
     * out to have been wrong is one restore away rather than a year of
     * `archived_at` timestamps to unpick by hand.
     */
    sweepHour: int('DBK_ARCHIVE_SWEEP_HOUR', 3, { min: 0, max: 23 }),
    sweepMinute: int('DBK_ARCHIVE_SWEEP_MINUTE', 40, { min: 0, max: 59 }),
  },

  /**
   * How many reverse proxies sit in front of us. `req.ip` is taken that many
   * hops from the right of X-Forwarded-For.
   *
   * NOT `true`: that trusts the whole chain and returns the leftmost entry,
   * which the client writes. The per-IP login limiter is keyed on `req.ip`, so
   * a trusted-everything setting lets an attacker mint a fresh rate-limit
   * bucket per request with a spoofed header — and writes a fabricated address
   * into `session.ip`. One hop is correct behind a single reverse proxy; 0 is correct when the app
   * is reached directly, which is why this one accepts zero.
   */
  trustProxyHops: int('DBK_TRUST_PROXY_HOPS', 1, { min: 0 }),

  session: {
    cookieName: cookieSecure ? '__Host-dbk_sid' : 'dbk_sid',
    /** A school day plus slack, so nobody is logged out mid-lesson. */
    ttlMs: int('DBK_SESSION_TTL_HOURS', 12) * 3_600_000,
    /**
     * The ceiling on rolling extension, measured from `created_at`.
     *
     * Without one, a session in continuous use is renewed forever and a token
     * taken off a shared machine never expires. Seven days is far past any
     * lesson, so it can only ever fire between them.
     */
    absoluteTtlMs: int('DBK_SESSION_ABSOLUTE_TTL_HOURS', 24 * 7) * 3_600_000,
    secure: cookieSecure,
  },

  i18n: {
    defaultLocale: optional('DBK_DEFAULT_LOCALE', 'de'),
    supported: ['de', 'en'] as const,
  },

  paths: {
    // No `backups` entry, on purpose. It was here, defaulted, and read by
    // nothing — while docker-compose.yml mounted the real backup directory into
    // the container to match it. Those backups contain a copy of `.env`, so the
    // app had read-write access to its own encryption key for no feature at
    // all. Backups are the host's job; see the note in docker-compose.yml.
    archive: optional('DBK_ARCHIVE_DIR_CONTAINER', '/var/lib/datebaenkli/archive'),
  },

  bootstrapAdmin: {
    username: optional('DBK_BOOTSTRAP_ADMIN_USER', 'admin'),
    password: process.env['DBK_BOOTSTRAP_ADMIN_PASSWORD'] ?? '',
  },
} as const;

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}.\n` +
      `See .env.example — copy it to .env and fill in generated secrets.`,
  );
}

if (!config.i18n.supported.includes(config.i18n.defaultLocale as 'de' | 'en')) {
  throw new Error(
    `DBK_DEFAULT_LOCALE must be one of ${config.i18n.supported.join(', ')}, got: ${config.i18n.defaultLocale}`,
  );
}

if (config.limits.queryTimeoutMs <= statementTimeoutMs) {
  // The watchdog would fire first for everybody, so every ordinary runaway
  // query would cost a cancellation round trip and report as "cancelled" rather
  // than as the plain timeout it is. Not dangerous, but it inverts the two
  // limits and hides which one is doing the work.
  throw new Error(
    `DBK_QUERY_TIMEOUT_MS (${config.limits.queryTimeoutMs}) must be greater than ` +
      `DBK_STATEMENT_TIMEOUT (${statementTimeout} = ${statementTimeoutMs}ms).`,
  );
}

if (config.limits.poolMaxPerUser > config.limits.roleConnectionLimit) {
  // The app would open pool connections Postgres then refuses, and the student
  // would see "too many connections for role" instead of their query result.
  throw new Error(
    `DBK_POOL_MAX_PER_USER (${config.limits.poolMaxPerUser}) must be <= ` +
      `DBK_ROLE_CONNECTION_LIMIT (${config.limits.roleConnectionLimit}).`,
  );
}
