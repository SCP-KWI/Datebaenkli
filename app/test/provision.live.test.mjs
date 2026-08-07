/**
 * The provisioning engine against a REAL PostgreSQL server.
 *
 * `db/verify-isolation.sh` proves that the *SQL sequences* in ARCHITECTURE.md §2
 * work. This proves that `src/services/provision.ts` actually issues them — a
 * different claim, and the one that matters now that the SQL lives in code
 * rather than in a shell script. It drives the compiled provisioner and then
 * checks the result by connecting as the students themselves, because "the
 * teacher can read this table" is only true if a connection as the teacher can
 * read it, not if a GRANT returned without error.
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
 *     node --test test/provision.live.test.mjs
 *
 * Creates and destroys roles prefixed `t_lvt` / `u_lvt`. Do NOT point it at an
 * instance where those could be real people.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dist } from './support/meta-db.mjs';
import { TEACH_DB, dropRoles, liveSuite, tryAsUser } from './support/live-pg.mjs';

// Must be set before config.ts is imported — it reads the environment once.
const ARCHIVE_DIR = mkdtempSync(join(tmpdir(), 'dbk-archive-'));
process.env.DBK_ARCHIVE_DIR_CONTAINER = ARCHIVE_DIR;

const TEACHER = 't_lvt_schaffner';
const OTHER_TEACHER = 't_lvt_beispiel';
const LENA = 'u_lvt_muster_lena';
const TIM = 'u_lvt_meier_tim';
const ALL = [LENA, TIM, TEACHER, OTHER_TEACHER];

/** Passwords the provisioner is told to set; the assertions log in with them. */
const PW = Object.fromEntries(ALL.map((r) => [r, `pw-${r}-x1`]));

// The lock is held for the whole file: the live suites run in parallel
// processes and cannot provision at the same time. See support/live-lock.mjs.
const { LIVE, live, releaseLock } = await liveSuite('live provisioning suite');

const { makeProvisioner } = await import(dist('services/provision.js'));
const { makeDb } = await import(dist('db/query.js'));
const { teachAdminPool, closeAllPools } = await import(dist('db/pools.js'));

const teach = LIVE ? makeDb(teachAdminPool) : null;
const prov = LIVE ? makeProvisioner(teach) : null;

/**
 * The non-throwing form, because half the assertions in this file *are* the
 * failure: `assertDenied` needs the driver's message to check that Postgres
 * refused on privilege grounds and not because the role was missing.
 */
const asUser = (role, sql) => tryAsUser(role, PW[role], sql);

/**
 * A denial only counts if Postgres refused on privilege grounds. A connection
 * that failed because the role is missing proves nothing — counting those as
 * passes is how a suite goes green for the wrong reason.
 */
function assertDenied(result, what) {
  assert.equal(result.ok, false, `${what}: succeeded, should have been denied`);
  assert.match(
    result.error,
    /permission denied|must be owner|is not allowed/i,
    `${what}: failed, but not on privilege grounds — ${result.error}`,
  );
}

/** `ALL` is already students-first, which is the order `dropRoles` requires. */
const teardown = () => dropRoles(ALL);

live('provisioning creates the role, the schema it owns, and the session rails', async () => {
  await teardown();
  await prov.ensureTeacher({ pgRole: TEACHER, pgPassword: PW[TEACHER], canLogin: true });
  await prov.ensureStudent({
    pgRole: LENA,
    pgPassword: PW[LENA],
    canLogin: true,
    teacherRoles: [TEACHER],
  });

  const { rows } = await teach.query(
    `SELECT r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreaterole,
            r.rolconnlimit, n.nspname IS NOT NULL AS has_schema,
            pg_get_userbyid(n.nspowner) AS schema_owner
       FROM pg_roles r LEFT JOIN pg_namespace n ON n.nspname = r.rolname
      WHERE r.rolname = ANY($1::text[]) ORDER BY r.rolname`,
    [[TEACHER, LENA]],
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.rolcanlogin, true);
    assert.equal(row.rolsuper, false);
    assert.equal(row.rolcreaterole, false);
    assert.equal(row.rolinherit, false, 'NOINHERIT keeps dbk_app from acting as them by accident');
    assert.equal(row.rolconnlimit, 4);
    assert.equal(row.has_schema, true);
    assert.equal(row.schema_owner, row.rolname, 'role name == schema name == owner');
  }

  // search_path is "$user", public, so an unqualified CREATE TABLE has to land
  // in their own schema with no per-session setup. That equality is the whole
  // reason the three names are one string.
  assert.ok((await asUser(LENA, `CREATE TABLE kunden(id int primary key, name text)`)).ok);
  // Deliberately unqualified — the claim is that an unqualified CREATE landed
  // somewhere sensible on its own. Scoped to this suite's own prefix all the
  // same: `kunden` is the likeliest table name in the entire instance (the demo
  // schema teaches that vocabulary), and any other schema's copy would sort
  // first and answer for this one.
  const where = await asUser(
    LENA,
    `SELECT schemaname FROM pg_tables WHERE tablename = 'kunden' AND schemaname LIKE 'u\\_lvt\\_%'`,
  );
  assert.equal(where.rows.length, 1);
  assert.equal(where.rows[0].schemaname, LENA);

  const timeout = await asUser(LENA, `SHOW statement_timeout`);
  assert.equal(timeout.rows[0].statement_timeout, '15s');
});

live('a student cannot touch another student', async () => {
  await prov.ensureStudent({
    pgRole: TIM,
    pgPassword: PW[TIM],
    canLogin: true,
    teacherRoles: [TEACHER],
  });

  assertDenied(await asUser(TIM, `SELECT * FROM ${LENA}.kunden`), 'read');
  assertDenied(await asUser(TIM, `CREATE TABLE ${LENA}.evil(x int)`), 'write');
  assertDenied(await asUser(TIM, `DROP TABLE ${LENA}.kunden`), 'drop');
});

live('the teacher reads their students, including tables created after the grant', async () => {
  assert.ok((await asUser(TEACHER, `SELECT name FROM ${LENA}.kunden`)).ok);

  // The ALTER DEFAULT PRIVILEGES line. Without it the teacher's view silently
  // stops at whatever existed at provisioning time.
  assert.ok((await asUser(LENA, `CREATE TABLE bestellungen(id int)`)).ok);
  assert.ok((await asUser(TEACHER, `SELECT count(*) FROM ${LENA}.bestellungen`)).ok);

  assertDenied(
    await asUser(TEACHER, `INSERT INTO ${LENA}.kunden VALUES (1, 'x')`),
    'teacher write',
  );
});

live('a student cannot make their teacher execute code by browsing the schema', async () => {
  // The confused deputy, and the reason `grantTeacherSql` revokes EXECUTE from
  // PUBLIC. Three correct behaviours composed into an exfiltration path:
  //
  //   - `GRANT SELECT ON ALL TABLES` and its `ALTER DEFAULT PRIVILEGES` twin
  //     cover *views*, so any view Lena creates is readable by her teacher.
  //   - A view resolves table access as the view's owner, but a function called
  //     inside it is `SECURITY INVOKER` by default — it runs as whoever ran the
  //     SELECT.
  //   - `EXECUTE` on a new function goes to `PUBLIC` by default.
  //
  // So a function doing `INSERT INTO lena.loot SELECT * FROM tim.kunden`, hidden
  // behind a plausibly-named view, copied a classmate's rows the moment the
  // teacher clicked it in the schema browser. `current_user` stands in for the
  // payload here: if it returns the teacher's name, the door is open.
  //
  // `current_user` is the payload's stand-in: if it comes back as the teacher's
  // role, the door is open.
  assert.ok(
    (
      await asUser(
        LENA,
        `CREATE FUNCTION wer_bin_ich() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`,
      )
    ).ok,
    'a student may still write functions — that is a lesson, not a threat',
  );

  // Re-issuing the grant is what runs `REVOKE EXECUTE ON ALL ROUTINES`, and it
  // is the whole of the database-side control: it covers what exists when it
  // runs. `resetSchema` and the reconciler's repair go through the same call.
  await prov.grantTeacher(LENA, TEACHER);

  assert.ok((await asUser(LENA, `CREATE VIEW auswertung AS SELECT wer_bin_ich() AS wer`)).ok);
  assert.ok(
    (await asUser(LENA, `SELECT * FROM auswertung`)).ok,
    'a student must still be able to run their own function',
  );

  assertDenied(
    await asUser(TEACHER, `SELECT ${LENA}.wer_bin_ich()`),
    'teacher executing a student function directly',
  );
  assertDenied(
    await asUser(TEACHER, `SELECT * FROM ${LENA}.auswertung`),
    'teacher executing a student function through a view',
  );

  // --- and here is the half that is still open ----------------------------
  //
  // Pinned deliberately, as a failing-open fact rather than a silence. A
  // routine created *after* the grant ran is executable by the teacher again,
  // because `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ... FROM PUBLIC` does
  // not do what its name suggests — see the long note in `grantTeacherSql`.
  //
  // When that is fixed (event trigger, or a scheduled re-issue of the REVOKE),
  // this assertion is the one that will start failing. Invert it then; do not
  // delete it.
  assert.ok(
    (
      await asUser(
        LENA,
        `CREATE FUNCTION danach() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`,
      )
    ).ok,
  );
  const stillOpen = await asUser(TEACHER, `SELECT ${LENA}.danach()`);
  assert.equal(
    stillOpen.ok,
    true,
    'a routine created after provisioning is expected to still be executable — ' +
      'if this now fails, the gap has been closed and this assertion should be inverted',
  );
  assert.equal(Object.values(stillOpen.rows[0])[0], TEACHER, 'and it runs as the teacher');

  // Cleaned up so the later `inventory` and `reset` assertions see the schema
  // shape they were written against.
  assert.ok((await asUser(LENA, `DROP VIEW auswertung`)).ok);
  assert.ok((await asUser(LENA, `DROP FUNCTION wer_bin_ich()`)).ok);
  assert.ok((await asUser(LENA, `DROP FUNCTION danach()`)).ok);
});

live('a grant issued late still covers tables that already existed', async () => {
  // ARCHITECTURE.md §2 grants on an empty schema, so `ON ALL TABLES` never
  // mattered there. It matters here: a teacher who takes a class over in week
  // six, or a student enrolled into a second subject, would otherwise see only
  // what the student creates from that moment on.
  await prov.ensureTeacher({
    pgRole: OTHER_TEACHER,
    pgPassword: PW[OTHER_TEACHER],
    canLogin: true,
  });
  assertDenied(await asUser(OTHER_TEACHER, `SELECT * FROM ${LENA}.kunden`), 'before the grant');

  await prov.grantTeacher(LENA, OTHER_TEACHER);
  assert.ok(
    (await asUser(OTHER_TEACHER, `SELECT * FROM ${LENA}.kunden`)).ok,
    'a pre-existing table must be visible',
  );
});

live('revoking takes the access away again, including from future tables', async () => {
  await prov.revokeTeacher(LENA, OTHER_TEACHER);
  assertDenied(await asUser(OTHER_TEACHER, `SELECT * FROM ${LENA}.kunden`), 'after revoke');

  // The default-privileges half: without revoking those too, the next table
  // Lena creates would silently be readable again.
  assert.ok((await asUser(LENA, `CREATE TABLE spaeter(id int)`)).ok);
  assertDenied(await asUser(OTHER_TEACHER, `SELECT * FROM ${LENA}.spaeter`), 'new table');
  assert.ok((await asUser(TEACHER, `SELECT * FROM ${LENA}.spaeter`)).ok, 'their own teacher keeps it');
});

live('a GRANT to PUBLIC is visible to inventory and revocable', async () => {
  // `grantee = 0` IS PUBLIC in aclexplode, and `inventory` used to filter it
  // out with `AND a.grantee <> 0`. That made the widest grant in the system the
  // one thing the repair pass could not see: every account in the school could
  // read the schema, permanently, and reconcile reported the instance clean.
  assert.ok((await asUser(LENA, `GRANT USAGE ON SCHEMA ${LENA} TO PUBLIC`)).ok);
  assert.ok((await asUser(LENA, `GRANT SELECT ON ALL TABLES IN SCHEMA ${LENA} TO PUBLIC`)).ok);

  // TIM is in no class with LENA and holds no grant on her schema, so if he can
  // read it, it is via PUBLIC and nothing else.
  assert.ok(
    (await asUser(TIM, `SELECT * FROM ${LENA}.kunden`)).ok,
    'precondition: the PUBLIC grant actually took',
  );

  const seen = await prov.inventory([LENA]);
  assert.equal(
    (seen.usageGrants.get(LENA) ?? new Set()).has('PUBLIC'),
    true,
    'inventory must report PUBLIC as a grantee',
  );

  await prov.revokeTeacher(LENA, 'PUBLIC');
  assertDenied(await tryAsUser(TIM, PW[TIM], `SELECT * FROM ${LENA}.kunden`), 'after revoking PUBLIC');

  const after = await prov.inventory([LENA]);
  assert.equal((after.usageGrants.get(LENA) ?? new Set()).has('PUBLIC'), false);
  assert.ok(
    (await asUser(TEACHER, `SELECT * FROM ${LENA}.kunden`)).ok,
    'revoking PUBLIC must not take the real teacher grant with it',
  );
});

live('inventory reports roles, schemas and who holds USAGE', async () => {
  const inv = await prov.inventory([...ALL, 'u_lvt_does_not_exist']);
  assert.equal(inv.roles.has(LENA), true);
  assert.equal(inv.roles.has('u_lvt_does_not_exist'), false);
  assert.equal(inv.schemas.has(LENA), true);
  assert.deepEqual([...(inv.usageGrants.get(LENA) ?? [])], [TEACHER]);
  assert.equal(
    inv.usageGrants.has(TEACHER),
    false,
    'nobody is granted on a teacher playground schema',
  );
});

live('a student cannot create a large object', async () => {
  // A large object belongs to no schema, and that one fact defeats three
  // controls at once: `schemaUsage` walks `pg_class` and cannot see it,
  // `DROP SCHEMA ... CASCADE` does not remove it, and `pg_dump --schema=`
  // does not carry it. So it was unquotaed storage that survived a reset and
  // appeared in no report, needing nothing but CONNECT to create.
  //
  // Measuring it was the obvious fix and is not available — sizing needs SELECT
  // on `pg_largeobject`, which is superuser-only, and joining it made
  // `schemaUsage` throw 42501 for every caller. So the constructors are revoked
  // from PUBLIC in `db/init/00-bootstrap.sh` instead.
  //
  // **This test fails against a cluster bootstrapped before that revoke**, which
  // is the intended signal rather than a flake: the statements are in HANDOFF
  // and have to be applied by hand once to an existing instance.
  for (const sql of [
    `SELECT lo_from_bytea(0, repeat('a', 1000)::bytea)`,
    `SELECT lo_creat(-1)`,
    `SELECT lo_create(0)`,
  ]) {
    assertDenied(await asUser(LENA, sql), sql);
  }

  // The way back out stays open: someone holding an object from before the
  // revoke has to be able to look at it and drop it.
  assert.ok((await asUser(LENA, `SELECT count(*) FROM pg_largeobject_metadata`)).ok);

  // Not asserted here, and deliberately: that `resetSchema`'s `DROP OWNED BY`
  // reclaims an object created *before* the revoke. Standing that up needs a
  // superuser to make the fixture — `dbk_app` is PUBLIC too and lost the
  // constructors with everyone else, which is itself the right outcome and is
  // harmless, since no app code calls `lo_*`. The same `DROP OWNED BY` is
  // exercised by the deprovisioning test below.
});

live('reset wipes the schema and puts the teacher grant back', async () => {
  // DROP SCHEMA takes the grants and the default privileges with it, because
  // both are properties of the schema. Recreating without re-granting is how a
  // teacher loses sight of a class one reset at a time.
  await prov.resetSchema(LENA, [TEACHER]);

  const gone = await asUser(LENA, `SELECT * FROM kunden`);
  assert.equal(gone.ok, false);
  assert.match(gone.error, /does not exist/);

  assert.ok((await asUser(LENA, `CREATE TABLE frisch(id int)`)).ok, 'the schema is usable again');
  assert.ok(
    (await asUser(TEACHER, `SELECT * FROM ${LENA}.frisch`)).ok,
    'the teacher must still be able to read',
  );
});

live('provisioning the same account twice is not an error', async () => {
  // The reconciler runs these over accounts that already exist, so every step
  // has to be "make it so", not "do it once".
  await prov.ensureStudent({
    pgRole: LENA,
    pgPassword: PW[LENA],
    canLogin: true,
    teacherRoles: [TEACHER],
  });
  await prov.grantTeacher(LENA, TEACHER);
  assert.ok((await asUser(LENA, `SELECT 1`)).ok, 'still able to log in with the same password');
  assert.ok((await asUser(TEACHER, `SELECT * FROM ${LENA}.frisch`)).ok);
});

live('archiving takes the login away but leaves the work intact', async () => {
  await prov.setLogin(TIM, false);
  const refused = await asUser(TIM, 'SELECT 1');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /is not permitted to log in/i);

  const { rows } = await teach.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [TIM]);
  assert.equal(rows.length, 1, 'the schema must survive archival');

  await prov.setLogin(TIM, true);
  assert.ok((await asUser(TIM, 'SELECT 1')).ok, 'restoring must actually restore');
});

live('a role with no CONNECT is visible to inventory and repairable', async () => {
  // The restore scenario, in miniature. A `pg_restore` into a bootstrapped
  // database brings back every role, schema and row and leaves
  // `pg_database.datacl` as the bootstrap wrote it — REVOKEd from PUBLIC, with
  // no per-student grants, because neither dump carries a database ACL. This is
  // that state, produced the only way PGlite never could (HANDOFF §4dd).
  await teach.query(`REVOKE CONNECT ON DATABASE ${TEACH_DB} FROM ${LENA}`);

  const denied = await asUser(LENA, 'SELECT 1');
  assert.equal(denied.ok, false, 'the revoke must actually bite');
  assert.match(denied.error, /permission denied for database/i);

  // The half that was missing: reconcile can only repair what inventory reports.
  const before = await prov.inventory([LENA]);
  assert.equal(before.roles.get(LENA).canConnect, false);
  assert.equal(before.roles.get(LENA).canLogin, true, 'CONNECT is not the login flag');
  assert.ok(before.schemas.has(LENA), 'the schema is intact — only the grant is gone');

  await prov.grantConnect(LENA);

  const after = await prov.inventory([LENA]);
  assert.equal(after.roles.get(LENA).canConnect, true);
  assert.ok((await asUser(LENA, 'SELECT 1')).ok, 'the repair must actually restore access');
});

live('deprovisioning dumps to the archive, then drops the role and schema', async () => {
  const path = await prov.archiveAndDrop(TIM);
  assert.ok(path, 'a dump path must come back');
  assert.ok(
    readdirSync(ARCHIVE_DIR).some((f) => f.startsWith(TIM) && f.endsWith('.dump')),
    'the dump file must exist on disk',
  );

  const { rows } = await teach.query(
    `SELECT (SELECT count(*) FROM pg_roles WHERE rolname = $1) AS roles,
            (SELECT count(*) FROM pg_namespace WHERE nspname = $1) AS schemas`,
    [TIM],
  );
  assert.equal(Number(rows[0].roles), 0, 'REVOKE ALL ON DATABASE must precede DROP ROLE');
  assert.equal(Number(rows[0].schemas), 0);

  assert.ok((await asUser(LENA, 'SELECT * FROM frisch')).ok, 'other students are unaffected');
});

live('dropping an account that is already gone is a no-op', async () => {
  assert.equal(await prov.archiveAndDrop(TIM), null);
});

live('cleanup', async () => {
  await teardown();
  await closeAllPools();
  await releaseLock();
});
