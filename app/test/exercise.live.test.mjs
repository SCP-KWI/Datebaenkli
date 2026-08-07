/**
 * Exercise workspaces against a REAL PostgreSQL server — phase 9.
 *
 * `exercise.test.mjs` pins the bookkeeping. This suite exists for the claims
 * that only a real cluster can answer, and every one of them is a claim a mock
 * would have reported as passing while being wrong:
 *
 *   - a student's exercise workspace is **theirs**: the classmate sitting next
 *     to them cannot read it, and neither can they read the classmate's;
 *   - **"reset this exercise" is narrow** — it drops the exercise's tables and
 *     leaves the playground, and every *other* exercise, exactly as they were;
 *   - the teacher can read a workspace and cannot write to it;
 *   - **cold storage takes the workspaces with it.** This is the regression
 *     phase 9 creates if `coldStore`'s sweep is ever removed: it drops the
 *     playground by name, so a workspace would survive — undumped, on the disk
 *     it exists to reclaim, and enough to make a later `DROP ROLE` fail months
 *     afterwards with nothing to explain it.
 *
 * PGlite cannot execute a single `GRANT`, so none of the above is askable there.
 *
 * SKIPPED unless a server is reachable. Bring one up without Docker or sudo:
 *
 *   SP=/tmp/dbk && rm -rf $SP && mkdir -p $SP
 *   initdb -D $SP/data -U postgres --locale=C.UTF-8 --encoding=UTF8 -A trust
 *   pg_ctl -D $SP/data -o "-p 55432 -k /tmp -c listen_addresses=127.0.0.1" -l $SP/pg.log start
 *   PGHOST=127.0.0.1 PGPORT=55432 POSTGRES_USER=postgres \
 *     DBK_APP_DB_PASSWORD=secret bash db/init/00-bootstrap.sh
 *   cd app && npm run build
 *   PGHOST=127.0.0.1 PGPORT=55432 DBK_APP_DB_PASSWORD=secret \
 *     node --test test/exercise.live.test.mjs
 *
 * Creates and destroys roles prefixed `t_xlt` / `u_xlt`. Do NOT point it at an
 * instance where those could be real people.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dist } from './support/meta-db.mjs';
import { asUser as connectAs, dropRoles, liveSuite, tryAsUser } from './support/live-pg.mjs';

// Before `config.ts` is imported, which reads the environment once at module
// evaluation. `lifecycle.live.test.mjs` does the same and for the same reason:
// the default archive directory does not exist on a dev machine, and
// `coldStore` correctly refuses to drop a schema it could not dump — so without
// this the one case here that matters most fails for the least interesting
// reason, and it fails *after* the sweep it is checking has already run.
process.env.DBK_ARCHIVE_DIR_CONTAINER = mkdtempSync(join(tmpdir(), 'dbk-exercise-'));

const TEACHER = 't_xlt_lehrer';
const OTHER_TEACHER = 't_xlt_nord';
const LENA = 'u_xlt_muster_lena';
const TIM = 'u_xlt_meier_tim';
/** Students first: a teacher holding grants on a student's schema fails 2BP01. */
const ALL = [LENA, TIM, TEACHER, OTHER_TEACHER];
const PW = Object.fromEntries(ALL.map((r) => [r, `pw-${r}-x1`]));

/** Two exercises, so "reset one" can be shown not to touch the other. */
const EX_A = 91;
const EX_B = 92;
const wsOf = (student, exercise) => `x${exercise}_${student}`;

const { LIVE, live, releaseLock } = await liveSuite('live exercise suite');

const { makeProvisioner } = await import(dist('services/provision.js'));
const { makeDb } = await import(dist('db/query.js'));
const { teachAdminPool, closeAllPools } = await import(dist('db/pools.js'));

const teach = LIVE ? makeDb(teachAdminPool) : null;
const prov = LIVE ? makeProvisioner(teach) : null;

const asUser = (role, sql) => connectAs(role, PW[role], sql);

async function schemasOwnedBy(role) {
  const { rows } = await teach.query(
    `SELECT n.nspname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
      WHERE r.rolname = $1 ORDER BY 1`,
    [role],
  );
  return rows.map((r) => r.nspname);
}

async function tablesOf(schema) {
  const { rows } = await teach.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
    [schema],
  );
  return rows.map((r) => r.tablename);
}

const teardown = () => dropRoles(ALL);

/** The fixtures a materialisation would create, issued as the student. */
async function seed(student, schema, table, rows) {
  await asUser(
    student,
    `CREATE TABLE ${schema}.${table} (id integer PRIMARY KEY, wert text NOT NULL)`,
  );
  await asUser(
    student,
    `INSERT INTO ${schema}.${table} SELECT g, 'v' || g FROM generate_series(1, ${rows}) g`,
  );
}

live('setup', async () => {
  await teardown();
  for (const teacher of [TEACHER, OTHER_TEACHER]) {
    await prov.ensureTeacher({ pgRole: teacher, pgPassword: PW[teacher], canLogin: true });
  }
  for (const student of [LENA, TIM]) {
    await prov.ensureStudent({
      pgRole: student,
      pgPassword: PW[student],
      canLogin: true,
      teacherRoles: [TEACHER],
    });
    // Something in the playground, so every claim below about the playground
    // surviving has something to survive.
    await seed(student, student, 'meine_notizen', 3);
  }
});

live('a workspace is created owned by the student, not by dbk_app', async () => {
  // Ownership is the whole isolation story: `CREATE SCHEMA … AUTHORIZATION`
  // with the wrong role gives a schema the student cannot create a table in,
  // which is §4ee's shape and would look like "the exercise is broken".
  const result = await prov.createWorkspace(LENA, wsOf(LENA, EX_A), [TEACHER]);
  assert.equal(result.created, true);

  const owned = await schemasOwnedBy(LENA);
  assert.deepEqual(owned, [LENA, wsOf(LENA, EX_A)].sort());

  // And she can actually write in it — asked as her, which is the only way to
  // ask (HANDOFF §4a).
  await seed(LENA, wsOf(LENA, EX_A), 'kunden', 5);
  assert.deepEqual(await tablesOf(wsOf(LENA, EX_A)), ['kunden']);
});

live('createWorkspace is idempotent and reports that it created nothing', async () => {
  // `created: false` is what stops a second visit replaying the fixtures over
  // a student's work. It has to be the truth rather than a guess.
  const again = await prov.createWorkspace(LENA, wsOf(LENA, EX_A), [TEACHER]);
  assert.equal(again.created, false);
  assert.deepEqual(await tablesOf(wsOf(LENA, EX_A)), ['kunden'], 'the table was left alone');
});

live('a classmate cannot read another student’s workspace', async () => {
  await prov.createWorkspace(TIM, wsOf(TIM, EX_A), [TEACHER]);
  await seed(TIM, wsOf(TIM, EX_A), 'kunden', 2);

  // Both directions. One would pass with a grant accidentally issued one way.
  const timReadsLena = await tryAsUser(
    TIM,
    PW[TIM],
    `SELECT * FROM ${wsOf(LENA, EX_A)}.kunden`,
  );
  assert.equal(timReadsLena.ok, false, 'Tim read Lena’s exercise workspace');
  assert.match(timReadsLena.error, /permission denied/i);

  const lenaReadsTim = await tryAsUser(
    LENA,
    PW[LENA],
    `SELECT * FROM ${wsOf(TIM, EX_A)}.kunden`,
  );
  assert.equal(lenaReadsTim.ok, false, 'Lena read Tim’s exercise workspace');

  // And each still has their own, with their own row counts.
  const mine = await asUser(LENA, `SELECT count(*)::int AS n FROM ${wsOf(LENA, EX_A)}.kunden`);
  assert.equal(mine.rows[0].n, 5);
  const theirs = await asUser(TIM, `SELECT count(*)::int AS n FROM ${wsOf(TIM, EX_A)}.kunden`);
  assert.equal(theirs.rows[0].n, 2);
});

live('the teacher can read a workspace and cannot write to it', async () => {
  const read = await tryAsUser(
    TEACHER,
    PW[TEACHER],
    `SELECT count(*)::int AS n FROM ${wsOf(LENA, EX_A)}.kunden`,
  );
  assert.equal(read.ok, true, read.error);
  assert.equal(read.rows[0].n, 5);

  const write = await tryAsUser(TEACHER, PW[TEACHER], `DELETE FROM ${wsOf(LENA, EX_A)}.kunden`);
  assert.equal(write.ok, false, 'a teacher wrote to a student’s exercise workspace');
  assert.match(write.error, /permission denied/i);
});

live('a teacher who does not teach this student sees nothing', async () => {
  const read = await tryAsUser(
    OTHER_TEACHER,
    PW[OTHER_TEACHER],
    `SELECT * FROM ${wsOf(LENA, EX_A)}.kunden`,
  );
  assert.equal(read.ok, false, 'another teacher read a workspace they were never granted');
});

live('a table created after the grant is readable too', async () => {
  // `ALTER DEFAULT PRIVILEGES` is what covers this, and it is the half that is
  // silently missing when only `ON ALL TABLES` is issued: the teacher's view
  // would stop at whatever existed the moment the workspace was made.
  await seed(LENA, wsOf(LENA, EX_A), 'spaeter', 1);
  const read = await tryAsUser(
    TEACHER,
    PW[TEACHER],
    `SELECT count(*)::int AS n FROM ${wsOf(LENA, EX_A)}.spaeter`,
  );
  assert.equal(read.ok, true, read.error);
});

live('dropping one workspace leaves the playground and the other exercises alone', async () => {
  // The claim the whole "a workspace is its own schema" design exists to make.
  await prov.createWorkspace(LENA, wsOf(LENA, EX_B), [TEACHER]);
  await seed(LENA, wsOf(LENA, EX_B), 'artikel', 4);

  await prov.dropWorkspace(LENA, wsOf(LENA, EX_A));

  assert.deepEqual(await schemasOwnedBy(LENA), [LENA, wsOf(LENA, EX_B)].sort());
  assert.deepEqual(await tablesOf(LENA), ['meine_notizen'], 'the playground is untouched');
  assert.deepEqual(await tablesOf(wsOf(LENA, EX_B)), ['artikel'], 'the other exercise too');
  assert.deepEqual(await tablesOf(wsOf(TIM, EX_A)), ['kunden'], 'and Tim’s copy of this one');
});

live('dropping a workspace is idempotent', async () => {
  await prov.dropWorkspace(LENA, wsOf(LENA, EX_A));
  assert.deepEqual(await schemasOwnedBy(LENA), [LENA, wsOf(LENA, EX_B)].sort());
});

live('listWorkspaces answers from pg_namespace, not from a list we kept', async () => {
  assert.deepEqual(await prov.listWorkspaces(LENA), [wsOf(LENA, EX_B)]);
  assert.deepEqual(await prov.listWorkspaces(TIM), [wsOf(TIM, EX_A)]);
});

live('the quota counts a workspace against the student who owns it', async () => {
  // The failure this catches is silent and gets worse the more the feature is
  // used: measure only the schema named after the student and the limit applies
  // to half of what they hold.
  const { makeQuotaGuard } = await import(dist('services/quota.js'));
  const guard = makeQuotaGuard(teach, 1024 ** 3);

  const before = await guard.usage(LENA);
  await seed(LENA, wsOf(LENA, EX_B), 'gross', 5000);
  const after = await guard.usage(LENA);

  assert.ok(after.bytes > before.bytes, 'a workspace table did not move the figure');

  // And it is attributed to *her*, not to everybody.
  const tims = await guard.usage(TIM);
  assert.ok(tims.bytes < after.bytes, 'Tim was charged for Lena’s exercise data');
});

live('schemaUsage reports a workspace as its own row', async () => {
  // The admin report and the lesson view both key on schema name; a workspace
  // that never appears is disk nobody can attribute.
  const usage = await prov.schemaUsage([LENA, wsOf(LENA, EX_B)]);
  const names = usage.map((u) => u.schema).sort();
  assert.deepEqual(names, [LENA, wsOf(LENA, EX_B)].sort());
});

live('a full reset drops the workspaces along with the playground', async () => {
  // `resetSchema` uses `DROP OWNED BY CURRENT_USER`, which is wide on purpose:
  // "wipe my whole database" means all of it. It is only safe because a
  // workspace is re-materialisable, which is the argument at the site.
  await prov.resetSchema(LENA, [TEACHER]);
  assert.deepEqual(await schemasOwnedBy(LENA), [LENA]);
  assert.deepEqual(await tablesOf(LENA), []);
});

live('cold storage leaves the account owning nothing at all', async () => {
  // The ordinary path. This passes with or without `coldStore`'s workspace
  // sweep — the `DROP OWNED BY CURRENT_USER` it ends with reaches them anyway,
  // which was checked by deleting the sweep and watching this still pass. It is
  // here because it is the claim that matters to an operator ("cold means the
  // disk is back"), not because it is the tightest test of any one line.
  await prov.createWorkspace(TIM, wsOf(TIM, EX_B), [TEACHER]);
  await seed(TIM, wsOf(TIM, EX_B), 'artikel', 3);
  assert.equal((await schemasOwnedBy(TIM)).length, 3, 'playground + two workspaces');

  await prov.coldStore(TIM);

  assert.deepEqual(await schemasOwnedBy(TIM), [], 'a workspace survived cold storage');
});

live('re-cooling an account with no playground still drops its workspaces', async () => {
  // THE regression case, and the only one that distinguishes the sweep from the
  // wide drop below it. `coldStore` returns early when the playground is
  // already gone, so everything after that point — including
  // `DROP OWNED BY CURRENT_USER` — never runs.
  //
  // Reachable rather than theoretical: `restoreStudent`'s failure path drops the
  // playground by name and leaves the workspaces, which is exactly the
  // cold-shaped state §4ff requires it to leave behind. Cooling that account
  // again is what an operator or the reconciler does next.
  assert.deepEqual(await schemasOwnedBy(TIM), [], 'fixture: TIM is cold from the case above');

  // Put TIM back into the awkward state by hand: a workspace, no playground.
  // `createWorkspace` runs as dbk_app, so it works on a NOLOGIN role — which is
  // itself the reason this state can exist.
  await prov.createWorkspace(TIM, wsOf(TIM, EX_A), [TEACHER]);
  assert.deepEqual(await schemasOwnedBy(TIM), [wsOf(TIM, EX_A)]);

  const dump = await prov.coldStore(TIM);
  assert.equal(dump, null, 'there was no playground to dump');
  assert.deepEqual(
    await schemasOwnedBy(TIM),
    [],
    'the early return skipped the sweep and left a workspace behind',
  );
});

live('and the role survives cold storage, NOLOGIN, so the restore is the same account', async () => {
  const { rows } = await teach.query(
    `SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`,
    [TIM],
  );
  assert.equal(rows.length, 1, 'cold storage dropped the role');
  assert.equal(rows[0].rolcanlogin, false);
});

live('a workspace name that looks like a role is refused before it reaches SQL', async () => {
  // db/ident.ts keeps two disjoint allow-lists. This is the assertion that they
  // are disjoint *in practice*: a role name must not be usable as a workspace,
  // or `dropWorkspace` becomes a way to drop somebody's playground.
  await assert.rejects(() => prov.createWorkspace(LENA, LENA, [TEACHER]), /Refusing to build SQL/);
  await assert.rejects(() => prov.dropWorkspace(LENA, LENA), /Refusing to build SQL/);
  await assert.rejects(() => prov.dropWorkspace(LENA, 'public'), /Refusing to build SQL/);
  await assert.rejects(() => prov.dropWorkspace(LENA, 'x1_u_nope; DROP SCHEMA public'), /Refusing/);

  // And the playground is still there, which is what the above was protecting.
  assert.deepEqual(await schemasOwnedBy(LENA), [LENA]);
});

live('teardown', async () => {
  // Not optional, and the assertion inside `dropRoles` is the half that matters:
  // HANDOFF §4u is the run where a swallowed teardown failure leaked a role into
  // a production cluster and permanently burned an identifier.
  await teardown();
  await releaseLock();
  await closeAllPools();
});
