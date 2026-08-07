/**
 * Cold storage and the archive sweep against a REAL PostgreSQL server — 5b.
 *
 * **This suite exists because of HANDOFF §4dd.** The restore drill found a
 * cluster with every role, every schema, every row, a reconciler reporting
 * "nothing to repair" — and not one student who could run a query. The general
 * lesson is that a restore is proven by *running the workload on it*, never by
 * the restore command exiting 0, and `cold -> active` has exactly that shape:
 * `pg_restore` returning 0 says statements ran, not that the student who owns
 * the tables can read them. So the central case below ends by opening a
 * connection **as the student**, with the password from `pg_password_enc`, and
 * selecting the rows she wrote before her schema was dumped. Nothing weaker
 * counts. `pg_restore`'s exit code is checked by `restoreStudent` itself and is
 * deliberately not what any assertion here rests on.
 *
 * It also pins the other half of §4dd: `reconcile` used to treat "role with no
 * schema" as unprovisioned, which is the *definition* of a cold account, and
 * would have created an empty schema over one — leaving the dump on disk with
 * nothing referring to it and calling the result "created". That test asserts an
 * absence, which is unusual and is the point.
 *
 * The meta database is PGlite and the teaching database is the real server, the
 * same split `query.live.test.mjs` uses: accounts need no privileges, roles and
 * schemas need everything.
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
 *     node --test test/lifecycle.live.test.mjs
 *
 * Creates and destroys roles prefixed `t_llt` / `u_llt`. Do NOT point it at an
 * instance where those could be real people — and note that the prefix is not
 * decoration: HANDOFF §4cc is the run where a suite deriving `t_schaffner` from
 * a bare surname silently adopted a teacher a human had created by clicking.
 * A live suite must not derive an identifier a human might also derive.
 */
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dist, freshMeta } from './support/meta-db.mjs';
// `tryAsUser`, not `asUser`: half of what this file asserts is a *refusal* — a
// cold account must not be able to log in — so the failure has to arrive as
// data rather than as a thrown error. support/live-pg.mjs has both.
import { TEACH_DB, dropRoles, liveSuite, tryAsUser as asUser } from './support/live-pg.mjs';

// Both must be set before config.ts is imported — it reads the environment
// once, at module evaluation. The default archive directory does not exist on a
// dev machine, and `coldStore` correctly refuses to drop a schema it could not
// dump, so without this every case here fails for the least interesting reason.
const ARCHIVE_DIR = mkdtempSync(join(tmpdir(), 'dbk-lifecycle-'));
process.env.DBK_ARCHIVE_DIR_CONTAINER = ARCHIVE_DIR;
// The sweep threshold this suite asserts against. Config validates it at import
// with a floor of 30 days, so the fixtures below are backdated past that rather
// than the threshold being lowered to something convenient.
process.env.DBK_ARCHIVE_AFTER_DAYS = '365';

// The lock is held for the whole file. `GRANT CONNECT ON DATABASE` updates one
// shared `pg_database` row, so two live suites provisioning at once get XX000
// "tuple concurrently updated" — HANDOFF §4h, support/live-lock.mjs.
const { LIVE, live, releaseLock } = await liveSuite('live lifecycle suite');

const users = await import(dist('services/users.js'));
const classes = await import(dist('services/classes.js'));
const lifecycle = await import(dist('services/lifecycle.js'));
const { reconcile } = await import(dist('services/reconcile.js'));
const { makeProvisioner } = await import(dist('services/provision.js'));
const { makeDb } = await import(dist('db/query.js'));
const pools = await import(dist('db/pools.js'));

let teach;
let prov;
let metaDb;
let adminId;
let lena;
let tim;
/** Teacher last, because roles must be dropped student-first — see `after`. */
const created = [];

const identityOf = (id) => users.pgIdentity(metaDb, id);

before(async () => {
  if (!LIVE) return;

  teach = makeDb(pools.teachAdminPool);
  prov = makeProvisioner(teach);

  const meta = await freshMeta();
  metaDb = meta.db;
  adminId = meta.adminId;

  const { user: teacher } = await users.createTeacher(metaDb, prov, adminId, {
    firstName: 'Philip',
    lastName: 'Lltschaffner',
  });
  const klass = await classes.createClass(metaDb, adminId, {
    code: 'llt',
    name: 'Lifecycle Live Test',
    teacherId: teacher.id,
  });
  const roster = await users.createStudents(metaDb, prov, adminId, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
    { firstName: 'Tim', lastName: 'Meier' },
  ]);
  for (const c of roster) {
    assert.equal(c.provisioning.ok, true, c.provisioning.error);
  }
  [lena, tim] = roster.map((c) => c.user);

  created.push(lena.pgRole, tim.pgRole, (await identityOf(teacher.id)).pgRole);
}, { timeout: 60_000 });

after(async () => {
  if (!LIVE) return;
  await pools.closeAllPools().catch(() => {});
  try {
    // `created` is built students-first deliberately — see its declaration, and
    // `dropRoles` for why the order is the caller's to get right.
    await dropRoles(created);
  } finally {
    await releaseLock();
  }
});

live('a student with work in her schema goes cold: dumped, dropped, still a role', async () => {
  const before_ = await identityOf(lena.id);
  const wrote = await asUser(
    lena.pgRole,
    before_.pgPassword,
    `CREATE TABLE kunden (id int primary key, name text);
     INSERT INTO kunden VALUES (1, 'Bühler'), (2, 'Zimmermann');`,
  );
  assert.equal(wrote.ok, true, wrote.error);

  const { user, provisioning } = await users.setUserState(
    metaDb,
    prov,
    adminId,
    lena.id,
    'cold',
  );
  assert.equal(provisioning.ok, true, provisioning.error);
  assert.equal(user.state, 'cold');

  // The dump exists, and its path is in the column rather than only in an
  // audit row — a trail is not an index (migration 002).
  const identity = await identityOf(lena.id);
  assert.ok(identity.archivePath, 'archive_path must name the dump');
  assert.ok(existsSync(identity.archivePath), `no dump at ${identity.archivePath}`);

  // The schema is gone; the role is not. That asymmetry is the decision.
  const { rows } = await teach.query(
    `SELECT (SELECT count(*)::int FROM pg_namespace WHERE nspname = $1) AS schemas,
            (SELECT rolcanlogin FROM pg_roles WHERE rolname = $1) AS canlogin,
            has_database_privilege($1, $2, 'CONNECT') AS canconnect`,
    [lena.pgRole, TEACH_DB],
  );
  assert.equal(rows[0].schemas, 0, 'cold means the disk is released');
  assert.equal(rows[0].canlogin, false, 'the role stays, NOLOGIN');
  // CONNECT survives on purpose: NOLOGIN is the archival boundary, CONNECT is
  // not, and a cold account that lost it would reactivate into §4dd's silence.
  assert.equal(rows[0].canconnect, true, 'CONNECT is not the boundary; LOGIN is');

  const denied = await asUser(lena.pgRole, identity.pgPassword, 'SELECT 1');
  assert.equal(denied.ok, false, 'a cold account must not be able to connect');
});

live('reconcile leaves a cold account alone — it does not recreate the schema', async () => {
  // HANDOFF §4dd, the half that was a data-loss-shaped bug already in the tree.
  // `!inventory.schemas.has(pgRole)` used to mean "unprovisioned", and a cold
  // account is precisely a role with no schema. This asserts an absence.
  const report = await reconcile(metaDb, prov, adminId);

  assert.equal(report.created.includes(lena.pgRole), false, 'reconcile re-provisioned a cold account');
  assert.equal(report.restored.includes(lena.pgRole), false, 'and it must not restore one either');
  assert.deepEqual(report.anomalies, [], 'no schema should have appeared');
  assert.deepEqual(report.failed, []);

  const { rows } = await teach.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [
    lena.pgRole,
  ]);
  assert.equal(rows[0].n, 0, 'an empty schema here would have orphaned the dump');

  // And the dump is still named by the row, which is what makes it findable.
  assert.ok((await identityOf(lena.id)).archivePath);
});

live('cold -> active restores the dump, and the STUDENT can read her own rows', async () => {
  // The §4dd assertion. Not "pg_restore exited 0", not "the tables exist" —
  // a connection opened as the student, with the password out of
  // pg_password_enc, returning the rows she wrote before the schema was
  // dropped. Only this path decrypts the stored password, opens a connection as
  // her, and depends on LOGIN, CONNECT, schema ownership and table ownership
  // all being right at once.
  const path = (await identityOf(lena.id)).archivePath;

  const { user, provisioning } = await users.setUserState(metaDb, prov, adminId, lena.id, 'active');
  assert.equal(provisioning.ok, true, provisioning.error);
  assert.equal(user.state, 'active');

  const identity = await identityOf(lena.id);
  const read = await asUser(
    lena.pgRole,
    identity.pgPassword,
    'SELECT name FROM kunden ORDER BY id',
  );
  assert.equal(read.ok, true, `the student cannot read her restored schema: ${read.error}`);
  assert.deepEqual(read.rows.map((r) => r.name), ['Bühler', 'Zimmermann']);

  // She owns it again, and this asserts the mechanism that makes that true.
  // The restore runs `--role=<her>` with `--no-owner`, so every object is
  // created *by* her and ownership is right by construction — there is no
  // `ALTER ... OWNER TO` in play at all. Running it as `dbk_app` instead was
  // the first design and it does not work: the dump's own schema-ownership
  // transfer leaves `dbk_app` without CREATE on the schema it just gave away
  // (§4a again). Reading is not enough to prove ownership, hence the INSERT.
  const wrote = await asUser(lena.pgRole, identity.pgPassword, `INSERT INTO kunden VALUES (3, 'Rüegg')`);
  assert.equal(wrote.ok, true, `the student does not own her restored tables: ${wrote.error}`);

  const { rows } = await teach.query(
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1`,
    [lena.pgRole],
  );
  assert.equal(rows[0].owner, lena.pgRole, 'role name == schema name == owner, still');

  // Cleared only after all of the above held. The dump file itself is left on
  // disk on purpose: deleting the last copy of a term's work at the moment the
  // restore succeeds is a bet on the restore, and §4dd is what such bets cost.
  assert.equal(identity.archivePath, null, 'archive_path is cleared once the work is back');
  assert.ok(existsSync(path), 'the dump file is deliberately not deleted');
});

live('a restore puts the teacher grant back from the roster, not from the dump', async () => {
  // `--no-privileges`: the dump carries the ACLs the schema had when it was
  // cooled, which may name a teacher who no longer teaches this student. The
  // roster is the source of truth, and `ensureStudent` is what applies it.
  const teacher = created[created.length - 1];
  const { rows } = await teach.query(
    `SELECT count(*)::int AS n
       FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
      WHERE n.nspname = $1 AND a.privilege_type = 'USAGE'
        AND pg_get_userbyid(a.grantee) = $2`,
    [lena.pgRole, teacher],
  );
  assert.equal(rows[0].n, 1, 'the teacher must be able to see the restored schema');
});

live('restoring twice is refused rather than restoring over live work', async () => {
  // Her real dump, still on disk — a made-up path would trip the "the dump is
  // gone" check first and prove nothing about the case this is for.
  const dump = join(
    ARCHIVE_DIR,
    readdirSync(ARCHIVE_DIR).find((f) => f.startsWith(lena.pgRole) && f.endsWith('.dump')),
  );
  const identity = await identityOf(lena.id);
  await assert.rejects(
    () =>
      prov.restoreStudent({
        pgRole: lena.pgRole,
        pgPassword: identity.pgPassword,
        canLogin: true,
        teacherRoles: identity.teacherRoles,
        archivePath: dump,
      }),
    /already exists/,
  );

  // And the refusal left her schema alone: the row she inserted after the
  // restore is still there. A guard that throws after clobbering is not a guard.
  const read = await asUser(lena.pgRole, identity.pgPassword, 'SELECT count(*)::int AS n FROM kunden');
  assert.equal(read.rows[0].n, 3);
});

live('a dump path outside the archive directory is refused', async () => {
  // The path comes out of a database row and is handed to a process running as
  // dbk_app. Confined, not trusted.
  const identity = await identityOf(tim.id);
  await assert.rejects(
    () =>
      prov.restoreStudent({
        pgRole: tim.pgRole,
        pgPassword: identity.pgPassword,
        canLogin: true,
        teacherRoles: identity.teacherRoles,
        archivePath: '/etc/passwd',
      }),
    /outside/,
  );
});

live('the reconciler restores an ARCHIVED account, which must stay NOLOGIN', async () => {
  // The case that had zero coverage and one real bug in it. Every other restore
  // here runs with canLogin: true; the reconciler restores whatever state the
  // row says, and for an archived account that is NOLOGIN — while
  // `restoreStudent`'s §4dd verification opens a connection *as the student*,
  // which NOLOGIN forbids. The first version therefore failed on exactly the
  // unattended path, after the data had already landed.
  const identity = await identityOf(tim.id);
  const wrote = await asUser(
    tim.pgRole,
    identity.pgPassword,
    `CREATE TABLE noten (fach text, note numeric(2,1));
     INSERT INTO noten VALUES ('Mathe', 5.5), ('Deutsch', 4.5);`,
  );
  assert.equal(wrote.ok, true, wrote.error);

  const cold = await users.setUserState(metaDb, prov, adminId, tim.id, 'cold');
  assert.equal(cold.provisioning.ok, true, cold.provisioning.error);

  // Move the row to 'archived' behind the service's back — reachable in the
  // wild as a failed restore that the nightly sweep then archives, and the one
  // shape that makes reconcile restore with canLogin false.
  await metaDb.query(`UPDATE app_user SET state = 'archived' WHERE id = $1`, [tim.id]);

  const report = await reconcile(metaDb, prov, adminId);
  assert.deepEqual(report.failed, [], 'the restore must not fail on its own verification');
  assert.deepEqual(report.restored, [tim.pgRole]);
  assert.deepEqual(report.created, [], 'an empty schema here would have orphaned the dump');

  // The rows are back. Counted through SET ROLE, not as `dbk_app` — it holds
  // student roles NOINHERIT, so the obvious `teach.query` is `permission denied
  // for schema` (§4a, which caught this assertion when it was first written).
  // The account is NOLOGIN by now, so connecting as the student is not an
  // option either; stepping into the role is the only way to ask.
  const rows = await teach.tx(async (q) => {
    await q.query(`SET ROLE ${tim.pgRole}`);
    try {
      return (await q.query(`SELECT count(*)::int AS n FROM ${tim.pgRole}.noten`)).rows;
    } finally {
      await q.query('RESET ROLE');
    }
  });
  assert.equal(rows[0].n, 2);

  // ...and the account is still archived, so the login it briefly needed to
  // verify itself has been taken away again.
  const { rows: role } = await teach.query(`SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`, [
    tim.pgRole,
  ]);
  assert.equal(role[0].rolcanlogin, false, 'a restored archived account must not be able to log in');
  assert.equal((await asUser(tim.pgRole, identity.pgPassword, 'SELECT 1')).ok, false);

  // And the dump is no longer named, because the restore actually completed.
  assert.equal((await identityOf(tim.id)).archivePath, null);

  await metaDb.query(`UPDATE app_user SET state = 'active' WHERE id = $1`, [tim.id]);
  await prov.setLogin(tim.pgRole, true);
});

live('a restore that fails leaves the account cold-shaped, not half-restored', async () => {
  // The invariant every failure path in `restoreStudent` has to hold: no
  // schema, NOLOGIN, dump still named. Anything else is unrepairable — the
  // reconciler's retry fires only for an account with *no* schema, so a schema
  // left behind makes the failure permanent AND invisible, and every later
  // reactivation dies on the "already exists" guard.
  const cold = await users.setUserState(metaDb, prov, adminId, lena.id, 'cold');
  assert.equal(cold.provisioning.ok, true, cold.provisioning.error);
  const identity = await identityOf(lena.id);

  // A real file inside the archive directory that is not a dump, so it gets
  // past the path and stat guards and fails inside pg_restore itself.
  const notADump = join(ARCHIVE_DIR, 'not-a-dump.dump');
  writeFileSync(notADump, 'this is not a custom-format archive\n');

  await assert.rejects(
    () =>
      prov.restoreStudent({
        pgRole: lena.pgRole,
        pgPassword: identity.pgPassword,
        canLogin: true,
        teacherRoles: identity.teacherRoles,
        archivePath: notADump,
      }),
    /restore of schema/,
  );

  const { rows } = await teach.query(
    `SELECT (SELECT count(*)::int FROM pg_namespace WHERE nspname = $1) AS schemas,
            (SELECT rolcanlogin FROM pg_roles WHERE rolname = $1) AS canlogin`,
    [lena.pgRole],
  );
  assert.equal(rows[0].schemas, 0, 'a failed restore must not leave a schema behind');
  assert.equal(rows[0].canlogin, false, 'nor a login into an account with no schema');
  assert.ok((await identityOf(lena.id)).archivePath, 'and the real dump is still named');

  // Cold-shaped means retryable, which is the whole point: the same account
  // now restores from its real dump with no intervention.
  const back = await users.setUserState(metaDb, prov, adminId, lena.id, 'active');
  assert.equal(back.provisioning.ok, true, back.provisioning.error);
  const read = await asUser(
    lena.pgRole,
    (await identityOf(lena.id)).pgPassword,
    'SELECT count(*)::int AS n FROM kunden',
  );
  assert.equal(read.ok, true, read.error);
  assert.equal(read.rows[0].n, 3);
});

live('the nightly sweep archives an idle student, for real', async () => {
  await metaDb.query(`UPDATE app_user SET last_active_at = now() - interval '400 days' WHERE id = $1`, [
    tim.id,
  ]);
  const identity = await identityOf(tim.id);
  assert.equal((await asUser(tim.pgRole, identity.pgPassword, 'SELECT 1')).ok, true);

  const report = await lifecycle.sweepInactiveStudents(metaDb, prov, null);
  assert.deepEqual(report.archived.map((c) => c.pgRole), [tim.pgRole]);
  assert.deepEqual(report.failed, []);

  // NOLOGIN in the teaching database, not merely a changed row in the meta one.
  const denied = await asUser(tim.pgRole, identity.pgPassword, 'SELECT 1');
  assert.equal(denied.ok, false, 'an archived student must not be able to connect');

  // And the schema is untouched — archived is reversible by design. Lena is
  // active and recently created, so she is not swept.
  const { rows } = await teach.query(
    `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ANY($1)`,
    [[tim.pgRole, lena.pgRole]],
  );
  assert.equal(rows[0].n, 2, 'archiving must not destroy work');
  assert.equal((await users.getUser(metaDb, lena.id)).state, 'active');
});

live('reconcile is clean over the mixed states this suite has produced', async () => {
  // One active student, one archived, one teacher. Nothing here is a repair,
  // and a reconciler that finds work to do in a healthy instance is a
  // reconciler nobody will read the output of.
  const report = await reconcile(metaDb, prov, adminId);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.restored, []);
  assert.deepEqual(report.loginFixed, []);
  assert.deepEqual(report.anomalies, []);
});
