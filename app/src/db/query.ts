/**
 * A minimal database handle the services are written against.
 *
 * Services take a `Db` rather than importing `metaPool` directly, for two
 * reasons: transactions need a single pinned connection (running `BEGIN` on a
 * pool hands the next statement to a different backend), and the test suite
 * drives the very same service functions against PGlite, which is not a
 * node-postgres pool. See test/services.test.mjs.
 */

import type { Pool, PoolClient, QueryResultRow } from 'pg';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface Db extends Queryable {
  /** Runs `fn` inside a transaction on one pinned connection. Rolls back on throw. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

function client(c: Pool | PoolClient): Queryable {
  return {
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      return c.query<R>(text, values) as Promise<QueryResult<R>>;
    },
  };
}

export function makeDb(pool: Pool): Db {
  return {
    ...client(pool),
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const out = await fn(client(conn));
        await conn.query('COMMIT');
        return out;
      } catch (err) {
        // A failed ROLLBACK (dead connection) must not mask the real error.
        await conn.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
  };
}

/** First row, or undefined. Exists mostly to keep `noUncheckedIndexedAccess` quiet at call sites. */
export function one<R>(result: QueryResult<R>): R | undefined {
  return result.rows[0];
}
