/**
 * The query runner and the watchdog against a REAL PostgreSQL server.
 *
 * This is the suite that matters for phase 3, because the two things the runner
 * is built around are both invisible to PGlite:
 *
 *   - **Cancellation.** `dbk_app` holds student roles `WITH INHERIT FALSE`, so a
 *     bare `pg_cancel_backend()` from the admin pool is refused with 42501. A
 *     watchdog that issued it that way would pass every mock-based test and
 *     never once have stopped a query. The test below therefore does what a
 *     student can actually do — `SET statement_timeout = 0` and then run
 *     forever — and asserts that the query still dies.
 *
 *   - **Connection hygiene.** A cancelled statement inside a transaction leaves
 *     the session in 25P02, which a pool would hand to the next request.
 *
 * The meta database is PGlite (accounts and `query_log` need no privileges);
 * the teaching database is the real server. That split is the point: it puts
 * the real engine in front of the real Postgres without needing two clusters.
 *
 * SKIPPED unless a server is reachable. See docs/HANDOFF.md §6, or:
 *
 *   SP=/tmp/dbk && rm -rf $SP && mkdir -p $SP
 *   initdb -D $SP/data -U postgres --locale=C.UTF-8 --encoding=UTF8 -A trust
 *   pg_ctl -D $SP/data -o "-p 55432 -k /tmp -c listen_addresses=127.0.0.1 \
 *     -c temp_file_limit=256MB" -l $SP/pg.log start
 *   PGHOST=127.0.0.1 PGPORT=55432 POSTGRES_USER=postgres \
 *     DBK_APP_DB_PASSWORD=secret bash db/init/00-bootstrap.sh
 *   cd app && npm run build
 *   PGHOST=127.0.0.1 PGPORT=55432 DBK_APP_DB_PASSWORD=secret \
 *     node --test test/query.live.test.mjs
 *
 * Creates and destroys roles prefixed `t_qlt` / `u_qlt`. Do NOT point it at an
 * instance where those could be real people.
 */
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { dist, freshMeta } from './support/meta-db.mjs';
import { dropRoles, liveSuite } from './support/live-pg.mjs';

// Must be set before config.ts is imported — it reads the environment once.
//
// The role default is deliberately left *shorter* than the watchdog, the way
// production has it: a student who does nothing clever is stopped by Postgres
// at 1s, and only one who lifts that limit ever reaches the watchdog at 2.5s.
// Both are then short enough to assert against without a slow suite.
process.env.DBK_STATEMENT_TIMEOUT = '1s';
process.env.DBK_QUERY_TIMEOUT_MS = '2500';
process.env.DBK_CANCEL_GRACE_MS = '1500';
// One connection per student, so "the next query reuses the same backend" is a
// fact rather than a coin flip — which is what makes the hygiene test real.
process.env.DBK_POOL_MAX_PER_USER = '1';

// The lock is held for the whole file: the live suites run in parallel
// processes and cannot provision at the same time. See support/live-lock.mjs.
const { LIVE, live, releaseLock } = await liveSuite('live query suite');

const users = await import(dist('services/users.js'));
const classes = await import(dist('services/classes.js'));
const { makeProvisioner } = await import(dist('services/provision.js'));
const { makeWatchdog } = await import(dist('services/watchdog.js'));
const { makeQueryRunner } = await import(dist('services/query.js'));
const { makeQuotaGuard } = await import(dist('services/quota.js'));
const { makeDb } = await import(dist('db/query.js'));
const pools = await import(dist('db/pools.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let runner;
let overQuotaRunner;
let lena;
let teach;
let metaDb;
const created = [];

before(async () => {
  if (!LIVE) return;

  teach = makeDb(pools.teachAdminPool);
  const prov = makeProvisioner(teach);

  const { db, adminId } = await freshMeta();
  metaDb = db;
  // The surname is namespaced for the same reason `catalog`, `import` and
  // `provision` hardcode `t_lct_` / `t_lit_` / `t_lvt_` roles: this suite runs
  // against a *fresh meta* database but a *shared* teaching one, so its
  // identifier allocator cannot see accounts that already exist in the real
  // meta. A bare 'Schaffner' derives `t_schaffner`, and provisioning is
  // idempotent, so the suite silently adopts a teacher a human already created
  // — then fails teardown with 2BP01 because that teacher's real students hold
  // grants on it, and reports a leak that is not one. Harmless before phase 5,
  // when the only way to create a teacher was curl; the roster UI makes a
  // populated dev cluster the normal case. The class code already namespaces
  // the students, so only the teacher needed this.
  const { user: teacher } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Philip',
    lastName: 'Qltschaffner',
  });
  const klass = await classes.createClass(db, adminId, {
    code: 'qlt',
    name: 'Query Live Test',
    teacherId: teacher.id,
  });
  const created_ = await users.createStudents(db, prov, adminId, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  // A provisioning failure here would surface later as a confusing connection
  // error; say so at the point it happened instead.
  assert.equal(created_[0].provisioning.ok, true, created_[0].provisioning.error);
  lena = created_[0].user;

  for (const id of [teacher.id, lena.id]) {
    const identity = await users.pgIdentity(db, id);
    created.push(identity.pgRole);
  }

  const watchdog = makeWatchdog(teach, { warn() {}, error() {} }, 1500);
  // A gigabyte, so every case below runs as though there were no quota. The two
  // quota cases build a second runner with a small one — the limit is a
  // parameter to `makeQuotaGuard` precisely so that a refusal can be tested
  // without first writing 50 MB.
  const quota = makeQuotaGuard(teach, 1024 ** 3);
  runner = makeQueryRunner({ db, watchdog, quota, getPool: pools.getUserPool });
  overQuotaRunner = makeQueryRunner({
    db,
    watchdog,
    quota: makeQuotaGuard(teach, 1),
    getPool: pools.getUserPool,
  });
}, { timeout: 30_000 });

after(async () => {
  if (!LIVE) return;
  await pools.closeAllPools().catch(() => {});
  try {
    // `created` is built teacher-first, and `dropRoles` requires the reverse:
    // a teacher holding USAGE/SELECT on a student's schema cannot be dropped
    // (2BP01), and those grants only go away with the student's schema.
    // Dropping in array order leaked the teacher on every single run — see
    // HANDOFF §4u, and support/live-pg.mjs's header for what it cost.
    await dropRoles([...created].reverse());
  } finally {
    await releaseLock();
  }
});

// --- running SQL -------------------------------------------------------------

live('a SELECT comes back with columns, rows and a command tag', async () => {
  const out = await runner.run(lena.id, `SELECT 1 AS eins, 'zwei' AS zwei`);

  assert.equal(out.ok, true);
  assert.equal(out.statements.length, 1);
  const [s] = out.statements;
  assert.equal(s.command, 'SELECT');
  assert.deepEqual(
    s.columns.map((c) => c.name),
    ['eins', 'zwei'],
  );
  assert.deepEqual(s.rows, [[1, 'zwei']]);
  assert.equal(s.truncated, false);
});

live('a script produces one result per statement', async () => {
  const out = await runner.run(
    lena.id,
    `CREATE TABLE kunden(id int, name text);
     INSERT INTO kunden VALUES (1, 'Meier'), (2, 'Müller');
     SELECT name FROM kunden ORDER BY id;`,
  );

  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.deepEqual(
    out.statements.map((s) => s.command),
    ['CREATE', 'INSERT', 'SELECT'],
  );
  assert.equal(out.statements[1].rowCount, 2, 'INSERT reports rows affected');
  // `rowCount` on a statement that returns no result set is rows *affected*, so
  // comparing it against the rows we kept would flag every INSERT as truncated.
  assert.equal(out.statements[1].truncated, false, 'an INSERT is not a clipped grid');
  assert.deepEqual(out.statements[2].rows, [['Meier'], ['Müller']]);
});

live('duplicate column names both survive', async () => {
  // The reason rowMode is 'array': as objects the second `a` would overwrite
  // the first and the grid would show one column where the student wrote two.
  const out = await runner.run(lena.id, `SELECT 1 AS a, 2 AS a`);
  assert.deepEqual(out.statements[0].rows, [[1, 2]]);
  assert.equal(out.statements[0].columns.length, 2);
});

live('dates reach the grid as Postgres wrote them, not as JS Dates', async () => {
  // node-postgres parses `date` into a JS Date at *local* midnight, which the
  // grid then serialises as `2025-04-02T22:00:00.000Z` — the day before, because
  // Zurich is UTC+2 in April. A student who imports 03.04.2025 and reads 2 April
  // in the result pane has been told their data is wrong when it is not.
  //
  // Only reproducible with a real server and a non-UTC TZ, which is why it sat
  // undetected until CSV upload made date columns ordinary.
  const out = await runner.run(
    lena.id,
    `SELECT DATE '2025-04-03', TIMESTAMP '2025-04-03 14:30:00', TIME '08:15:00'`,
  );

  assert.equal(out.ok, true);
  assert.deepEqual(out.statements[0].rows, [['2025-04-03', '2025-04-03 14:30:00', '08:15:00']]);
  for (const cell of out.statements[0].rows[0]) {
    assert.equal(typeof cell, 'string', 'strings, so JSON.stringify cannot shift the day');
  }
});

live('numbers and booleans are still parsed', async () => {
  // The date fix is scoped to five OIDs; everything else must keep its parser,
  // or `truncated`, row counts and the grid's alignment all quietly change.
  const out = await runner.run(lena.id, `SELECT 42, true, 1.5::float8, NULL`);
  assert.deepEqual(out.statements[0].rows, [[42, true, 1.5, null]]);
});

live('the row cap truncates the grid but still reports the true total', async () => {
  const out = await runner.run(lena.id, `SELECT * FROM generate_series(1, 5000)`);

  assert.equal(out.ok, true);
  const [s] = out.statements;
  assert.equal(s.rows.length, 1000, 'the fetch cap');
  assert.equal(s.rowCount, 5000, 'so the UI can say "showing the first 1000 of 5000"');
  assert.equal(s.truncated, true);
  assert.deepEqual(s.rows[0], [1], 'the first rows, not the last');
});

live('a syntax error is a 200 with a position, not an exception', async () => {
  const out = await runner.run(lena.id, `SELECT * FRM kunden`);

  assert.equal(out.ok, false);
  assert.equal(out.error.code, '42601');
  assert.ok(out.error.position > 0, 'the character offset is what underlines the typo');
  assert.equal(out.cancelled, undefined);
});

// --- the watchdog ------------------------------------------------------------

live('a student who disables statement_timeout is still stopped', async () => {
  // Exactly what HANDOFF §4 says a student can do, in one script so that both
  // statements land on the same backend. If the watchdog were built the obvious
  // way this would hang until the test timeout.
  const started = Date.now();
  const out = await runner.run(lena.id, `SET statement_timeout = 0; SELECT pg_sleep(30);`);
  const elapsed = Date.now() - started;

  assert.equal(out.ok, false);
  assert.equal(out.error.code, '57014');
  assert.deepEqual(out.cancelled, { reason: 'timeout' });
  assert.ok(elapsed < 10_000, `should have been cancelled at ~2.5s, took ${elapsed}ms`);
});

live('the role default still stops an ordinary runaway, without the watchdog', async () => {
  const started = Date.now();
  const out = await runner.run(lena.id, `SELECT pg_sleep(30)`);
  const elapsed = Date.now() - started;

  assert.equal(out.ok, false);
  assert.equal(out.error.code, '57014');
  assert.match(out.error.message, /statement timeout/);
  assert.ok(elapsed < 2_400, `Postgres should have stopped this at ~1s, took ${elapsed}ms`);
});

live('Cancel stops a running query and says so', async () => {
  const running = runner.run(lena.id, `SET statement_timeout = 0; SELECT pg_sleep(30);`);
  await sleep(400); // let it get as far as pg_sleep

  assert.equal(await runner.cancel(lena.id), 1);

  const out = await running;
  assert.equal(out.ok, false);
  assert.deepEqual(out.cancelled, { reason: 'user' }, 'not reported as a timeout');
});

live('cancelling when nothing is running is a no-op', async () => {
  assert.equal(await runner.cancel(lena.id), 0);
});

// --- connection hygiene ------------------------------------------------------

live('a cancelled statement does not poison the next query', async () => {
  // With DBK_POOL_MAX_PER_USER=1 the next run provably reuses this backend. A
  // cancel inside a transaction leaves it in 25P02, so without the ROLLBACK in
  // the runner's finally block every subsequent query would fail with
  // "current transaction is aborted".
  const running = runner.run(
    lena.id,
    `BEGIN; SET statement_timeout = 0; SELECT pg_sleep(30);`,
  );
  await sleep(400);
  await runner.cancel(lena.id);
  await running;

  const after = await runner.run(lena.id, `SELECT 1 AS still_working`);
  assert.equal(after.ok, true, JSON.stringify(after.error));
  assert.deepEqual(after.statements[0].rows, [[1]]);
});

live('an unclosed transaction does not leak into the next query', async () => {
  await runner.run(lena.id, `BEGIN; CREATE TABLE nie_committed(x int);`);

  const out = await runner.run(lena.id, `SELECT count(*) FROM nie_committed`);
  assert.equal(out.ok, false);
  assert.match(out.error.message, /does not exist/, 'the runner rolled it back');
});

// --- the log -----------------------------------------------------------------

live('every execution lands in query_log, errors included', async () => {
  await runner.run(lena.id, `SELECT 42 AS answer`);
  await runner.run(lena.id, `SELECT * FRM kaputt`);

  const { rows } = await metaDb.query(
    `SELECT sql_text, row_count, error_code, duration_ms
       FROM query_log WHERE user_id = $1 ORDER BY id DESC LIMIT 2`,
    [lena.id],
  );

  const [failed, ok] = rows;
  assert.equal(failed.error_code, '42601');
  assert.match(failed.sql_text, /FRM kaputt/);
  assert.equal(ok.error_code, null);
  assert.equal(ok.row_count, 1);
  assert.ok(ok.duration_ms >= 0, 'phase 4’s lesson view reads these');
});

live('a cancelled query is logged as cancelled', async () => {
  await runner.run(lena.id, `SET statement_timeout = 0; SELECT pg_sleep(30);`);

  const { rows } = await metaDb.query(
    `SELECT error_code FROM query_log WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [lena.id],
  );
  assert.equal(rows[0].error_code, '57014');
});

// --- the disk quota ----------------------------------------------------------

live('a student over quota is refused before a connection is taken', async () => {
  // One byte of quota against a schema holding a real table, so Lena is over it
  // by any measure. The refusal is a thrown ServiceError rather than
  // `{ ok: false }`: the SQL never ran, so there is no Postgres error to show
  // and nothing to underline in the editor.
  await runner.run(lena.id, `CREATE TABLE ballast AS SELECT * FROM generate_series(1, 5000) AS g(n)`);

  const { rows: before } = await metaDb.query(
    `SELECT count(*)::int AS n FROM query_log WHERE user_id = $1`,
    [lena.id],
  );

  await assert.rejects(
    () => overQuotaRunner.run(lena.id, `CREATE TABLE noch_mehr (a int)`),
    (err) => {
      assert.equal(err.code, 'quota_exceeded');
      assert.match(err.message, /over your limit/);
      return true;
    },
  );

  // Nothing ran, so nothing is logged as having run. A `query_log` row here
  // would put a CREATE TABLE in phase 4's lesson view that never happened.
  const { rows: after } = await metaDb.query(
    `SELECT count(*)::int AS n FROM query_log WHERE user_id = $1`,
    [lena.id],
  );
  assert.equal(after[0].n, before[0].n);
});

live('over quota, reading and dropping still work — but DELETE frees nothing', async () => {
  // The half that makes the quota survivable rather than a trap. A student
  // whose only recovery is DROP TABLE has to be able to run DROP TABLE, and
  // `mayGrow` is the thing that decides it — driven here through the real
  // runner rather than as a string test, because the claim is about what
  // Postgres ends up doing, not about a regular expression.
  const read = await overQuotaRunner.run(lena.id, `SELECT count(*) AS n FROM ballast`);
  assert.equal(read.ok, true, JSON.stringify(read.error));
  // A number, not a string: pools.ts parses int8 globally (`count(*)` is bigint).
  assert.deepEqual(read.statements[0].rows, [[5000]]);

  const quota = makeQuotaGuard(teach, 1);
  const before = await quota.usage(created[1]);

  const shrink = await overQuotaRunner.run(lena.id, `DELETE FROM ballast WHERE n > 100`);
  assert.equal(shrink.ok, true, JSON.stringify(shrink.error));

  // The reason the refusal message says DROP TABLE and not DELETE. Deleting
  // 98% of the rows frees nothing at all: the dead tuples stay in the heap
  // until VACUUM FULL rewrites it. A student told to "delete some rows" would
  // lose their data and still be locked out, which is why this is pinned here
  // rather than left as a remark in a comment.
  const afterDelete = await quota.usage(created[1]);
  assert.equal(afterDelete.bytes, before.bytes, 'DELETE freed nothing');

  const drop = await overQuotaRunner.run(lena.id, `DROP TABLE ballast`);
  assert.equal(drop.ok, true, JSON.stringify(drop.error));
  // `DROP`, not `DROP TABLE`: node-postgres keeps only the first word of the
  // CommandComplete tag. One more reason the page cannot decide anything from a
  // command tag — see HANDOFF §4g.
  assert.equal(drop.statements[0].command, 'DROP');
});
