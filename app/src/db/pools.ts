/**
 * Connection pools.
 *
 * Two kinds:
 *   - the two long-lived `dbk_app` pools (meta + teach), used for app data and
 *     for provisioning;
 *   - short-lived per-student pools, opened as the *student's own* Postgres
 *     role. That is the security boundary: isolation is enforced by Postgres,
 *     not by anything in this file. See docs/ARCHITECTURE.md §1.
 *
 * A `SET ROLE`-based alternative sharing one pool was rejected: a student can
 * type `RESET ROLE;` into the editor and escape it.
 */

import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

/**
 * Postgres returns bigint/numeric as strings by default to avoid precision
 * loss. For the meta database we own every column, and the ids are well within
 * Number.MAX_SAFE_INTEGER, so parsing int8 keeps the app code simple.
 *
 * NOTE: this is a *global* setting in node-postgres, so it also applies to
 * student result sets. That is deliberate — the query grid renders values as
 * text anyway, and student tables are small. Revisit if we ever surface real
 * bigint data where precision matters.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number.parseInt(v, 10));

function baseConfig() {
  return {
    host: config.pg.host,
    port: config.pg.port,
    application_name: 'datebaenkli',
  };
}

/** App data: users, classes, logs. Student roles have no access to this database. */
export const metaPool = new Pool({
  ...baseConfig(),
  database: config.pg.metaDb,
  user: config.pg.user,
  password: config.pg.password,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/** Teaching database as dbk_app — used for provisioning and quota checks only. */
export const teachAdminPool = new Pool({
  ...baseConfig(),
  database: config.pg.teachDb,
  user: config.pg.user,
  password: config.pg.password,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

for (const [name, pool] of [
  ['meta', metaPool],
  ['teach-admin', teachAdminPool],
] as const) {
  // An idle client erroring (e.g. the DB restarted) must not take the process
  // down — node-postgres emits 'error' on the pool for that.
  pool.on('error', (err) => {
    console.error(`[pool:${name}] idle client error:`, err.message);
  });
}

// --- per-student pools -------------------------------------------------------

interface UserPoolEntry {
  pool: pg.Pool;
  lastUsed: number;
}

const userPools = new Map<string, UserPoolEntry>();

/**
 * Get (or lazily create) a pool connected as `pgRole`.
 *
 * Pools are small and evicted after `poolIdleMs` of disuse, so a class of 25
 * holds at most ~50 backends during a lesson and none afterwards.
 */
export function getUserPool(pgRole: string, pgPassword: string): pg.Pool {
  const existing = userPools.get(pgRole);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.pool;
  }

  const pool = new Pool({
    ...baseConfig(),
    database: config.pg.teachDb,
    user: pgRole,
    password: pgPassword,
    max: config.limits.poolMaxPerUser,
    idleTimeoutMillis: config.limits.poolIdleMs,
    connectionTimeoutMillis: 10_000,
    application_name: `datebaenkli:${pgRole}`,
  });

  pool.on('error', (err) => {
    console.error(`[pool:${pgRole}] idle client error:`, err.message);
  });

  userPools.set(pgRole, { pool, lastUsed: Date.now() });
  return pool;
}

/** Close and forget a student's pool — call after deprovisioning or a password reset. */
export async function dropUserPool(pgRole: string): Promise<void> {
  const entry = userPools.get(pgRole);
  if (!entry) return;
  userPools.delete(pgRole);
  await entry.pool.end().catch(() => {});
}

let sweeper: NodeJS.Timeout | undefined;

/** Periodically end pools nobody has used, releasing their Postgres backends. */
export function startPoolSweeper(): void {
  if (sweeper) return;
  const interval = Math.max(config.limits.poolIdleMs, 30_000);
  sweeper = setInterval(() => {
    const cutoff = Date.now() - config.limits.poolIdleMs * 2;
    for (const [role, entry] of userPools) {
      if (entry.lastUsed < cutoff && entry.pool.idleCount === entry.pool.totalCount) {
        userPools.delete(role);
        entry.pool.end().catch(() => {});
      }
    }
  }, interval);
  sweeper.unref();
}

export function userPoolCount(): number {
  return userPools.size;
}

/** Graceful shutdown: close everything so Postgres sees clean disconnects. */
export async function closeAllPools(): Promise<void> {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
  const ends = [...userPools.values()].map((e) => e.pool.end().catch(() => {}));
  userPools.clear();
  ends.push(metaPool.end().catch(() => {}), teachAdminPool.end().catch(() => {}));
  await Promise.all(ends);
}
