/**
 * A mutex shared by every suite that provisions against the real server.
 *
 * `node --test test/*.test.mjs` runs the files in parallel processes, and the
 * live suites provision concurrently as a result. That fails, intermittently
 * and confusingly: `ensureRole` finishes with
 * `GRANT CONNECT ON DATABASE datebaenkli TO <role>`, which updates the one
 * `pg_database` row for the whole database, so two provisioners in flight at
 * the same moment get **XX000 "tuple concurrently updated"** — and then a
 * cascade of "relation does not exist" from the tests whose setup silently
 * half-ran.
 *
 * It was survivable while only two suites existed and one of them provisioned
 * just once in a `before()` hook. That was luck, not design, and it stopped
 * being lucky the moment a third suite arrived.
 *
 * A Postgres advisory lock is the right instrument because the resource being
 * contended *is* the database: it is visible to every process that connects,
 * regardless of which test runner started it, and a session-level lock is
 * released automatically when the connection drops — so a suite that crashes
 * mid-run cannot wedge the next one. The alternative, `--test-concurrency=1`,
 * would serialise the unit tests too and roughly double `npm test`.
 */

import pg from 'pg';

/** Arbitrary, but must be the same in every live suite. */
const LOCK_KEY = 0x0dbe_0001;

/**
 * Block until no other live suite is provisioning.
 *
 * Returns the release function. Call it in the suite's final test; if the
 * process dies first, closing the connection releases the lock anyway.
 */
export async function acquireLiveLock({ host, port, database, password }) {
  const client = new pg.Client({
    host,
    port,
    database,
    user: 'dbk_app',
    password,
    // Long: the wait here is another suite's whole provisioning run, not a
    // network round trip. Timing out would reintroduce exactly the flake this
    // exists to remove.
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

  return async () => {
    await client.end().catch(() => {});
  };
}
