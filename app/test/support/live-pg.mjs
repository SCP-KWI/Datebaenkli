/**
 * The plumbing every live suite needs: the connection coordinates, the server
 * probe, the advisory lock, connecting *as* a student, and the teardown that
 * drops the roles a run created.
 *
 * It exists because that plumbing was copy-pasted into five files and one copy
 * of it was wrong. HANDOFF §4u is that run: `query.live.test.mjs` dropped its
 * roles teacher-first, which fails with 2BP01, and the loop swallowed the error
 * with a bare `.catch(() => {})`. A `t_schaffner` role leaked into the
 * *production* teaching database, where `reconcile.ts` cannot see it — reconcile
 * is driven from `app_user`, and a role with no account is invisible to it — so
 * the identifier a real teacher would have been given is gone permanently. The
 * fix landed in one file and was pasted into the others. `dropRoles` below is
 * that fix, once.
 *
 * `support/live-lock.mjs` is the standing precedent: cross-suite live plumbing
 * lives beside the suites, not in each of them.
 *
 * What deliberately stayed in the suites is everything that says *what this
 * suite is about* — its role prefix and password map, its fixture setup, its
 * `after()` hook. Hoisting those would have turned five readable files into
 * five configuration blocks.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { acquireLiveLock } from './live-lock.mjs';

export const PGHOST = process.env.PGHOST ?? '127.0.0.1';
export const PGPORT = Number(process.env.PGPORT ?? 5432);
export const TEACH_DB = process.env.DBK_TEACH_DB ?? 'datebaenkli';

/**
 * Read at call time rather than captured into a `const` at import.
 *
 * `support/meta-db.mjs` sets the process-wide default in its module body and
 * every live suite imports it, so whether a `const` here saw that value or not
 * would depend on which import a suite happened to list first. Each of the five
 * suites carried its own `process.env.DBK_APP_DB_PASSWORD ??= 'secret'` line
 * that was already dead for exactly this reason — `meta-db.mjs` had set it
 * first — and nobody noticed, because every documented command sets the
 * variable explicitly. Reading late makes the question not arise.
 */
const appPassword = () => process.env.DBK_APP_DB_PASSWORD;

/** A `pg.Client` for `dbk_app` on the teaching database. */
const appClient = (extra) =>
  new pg.Client({
    host: PGHOST,
    port: PGPORT,
    database: TEACH_DB,
    user: 'dbk_app',
    password: appPassword(),
    ...extra,
  });

async function serverIsUp() {
  const client = appClient({ connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * The whole preamble, in the one order that works: probe, register the skip,
 * then take the lock — never the lock first, which would block forever waiting
 * for a server that is not there.
 *
 * Returns `live`, which is `test` or `test.skip`, and a `releaseLock` that is
 * safe to call when the suite skipped.
 *
 * `name` is only ever seen as the name of the skipped placeholder, so it should
 * read as one: "live catalog suite".
 */
export async function liveSuite(name) {
  const LIVE = await serverIsUp();
  if (!LIVE) {
    test(name, { skip: `no Postgres at ${PGHOST}:${PGPORT} — see the header` }, () => {});
    return { LIVE, live: test.skip, releaseLock: async () => {} };
  }
  const release = await acquireLiveLock({
    host: PGHOST,
    port: PGPORT,
    database: TEACH_DB,
    password: appPassword(),
  });
  return { LIVE, live: test, releaseLock: release };
}

/**
 * Open a connection AS `role` and run `sql`. Never throws — the failure is the
 * return value.
 *
 * This is the only thing that proves a claim about privileges. Asking `dbk_app`
 * what a student can see answers a different question, because it holds student
 * roles NOINHERIT (HANDOFF §4a).
 */
export async function tryAsUser(role, password, sql) {
  const client = new pg.Client({
    host: PGHOST,
    port: PGPORT,
    database: TEACH_DB,
    user: role,
    password,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    const result = await client.query(sql);
    return { ok: true, rows: result.rows, rowCount: result.rowCount };
  } catch (err) {
    return { ok: false, error: err.message, rows: [] };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * The same, for statements that are fixture *setup* rather than the claim.
 *
 * A suite asserting Tim is denied Lena's table needs the failure as data; a
 * suite creating Lena's table needs it as an explosion, because a silent
 * `{ ok: false }` there resurfaces three tests later as an inexplicable empty
 * result. One core, two names, and the call site says which it meant.
 */
export async function asUser(role, password, sql) {
  const result = await tryAsUser(role, password, sql);
  if (!result.ok) throw new Error(`as ${role}: ${result.error}\n  ${sql.trim()}`);
  return result;
}

/**
 * The DDL below concatenates the role name, because a `DO` body takes no bind
 * parameters and there is no `format()` outside plpgsql. CLAUDE.md's rule —
 * only `provision.ts` and `import.ts` may build SQL by concatenation — is about
 * `src`, and this is a test helper running against a throwaway cluster. But the
 * names it is handed are *derived*, from a class code and a surname, not
 * literals, and the check is two lines. `db/ident.ts`'s pattern, deliberately.
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Drop `roles` and then assert that none of them survived.
 *
 * **Order matters and the caller owns it: students first, teacher last.** A
 * teacher holding USAGE/SELECT on a student's schema cannot be dropped — 2BP01,
 * "cannot be dropped because some objects depend on it" — and those grants only
 * go away with the schema.
 *
 * Two things here are the §4u fix and neither is decoration. A per-role failure
 * is *reported* rather than swallowed, because the leak that burned a
 * production identifier was invisible precisely because it was swallowed. And
 * the drop is then *verified* against `pg_roles` rather than assumed, because a
 * live suite runs against whatever cluster it is pointed at — during a deploy,
 * the real one — so "cleaned up" has to be an assertion and not an intention.
 *
 * Opens its own connection rather than taking a `Db`: the suites that call this
 * from an `after()` hook have already run `closeAllPools()`, and the ones that
 * have not lose nothing by it.
 */
export async function dropRoles(roles) {
  if (roles.length === 0) return;
  for (const role of roles) {
    if (!IDENT.test(role)) {
      throw new Error(`refusing to interpolate ${JSON.stringify(role)} into teardown DDL`);
    }
  }

  const client = appClient();
  await client.connect();
  try {
    for (const role of roles) {
      await client
        .query(
          // SET ROLE and then DROP OWNED BY CURRENT_USER, not DROP OWNED BY the
          // role: `dbk_app` holds student roles NOINHERIT, so the direct form
          // does not see the student's objects. §4a in yet another disguise.
          //
          // The REVOKE is not redundant with it either: DROP OWNED BY covers
          // objects *in* the database but not grants *on* it, so DROP ROLE would
          // otherwise fail with "privileges for database datebaenkli".
          // `provision.ts`'s `archiveAndDrop` has the same three steps for the
          // same reasons.
          `DO $$ BEGIN
             IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
               EXECUTE format('SET ROLE %I', '${role}');
               EXECUTE 'DROP OWNED BY CURRENT_USER CASCADE';
               RESET ROLE;
               EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), '${role}');
               EXECUTE format('DROP ROLE %I', '${role}');
             END IF;
           END $$;`,
        )
        .catch((err) => {
          console.error(`[teardown] could not drop ${role}: ${err.message}`);
        });
    }

    const { rows } = await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [roles],
    );
    assert.deepEqual(
      rows.map((r) => r.rolname),
      [],
      'roles leaked into the teaching database; they hold their names forever',
    );
  } finally {
    await client.end().catch(() => {});
  }
}
