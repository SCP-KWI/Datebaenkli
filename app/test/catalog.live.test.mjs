/**
 * The schema browser's data against a REAL PostgreSQL server.
 *
 * This suite exists for the same reason the provisioning and query ones do:
 * every interesting claim it makes is about *privileges*, and PGlite is
 * single-user and cannot execute a single GRANT. A mock would report that the
 * catalog query ran and tell us nothing about the only question that matters —
 * whether a student can see another student's tables. `pg_class` is
 * world-readable, so getting that wrong is a list of every account in the
 * school, not a cosmetic bug.
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
 *     node --test test/catalog.live.test.mjs
 *
 * Creates and destroys roles prefixed `t_lct` / `u_lct`. Do NOT point it at an
 * instance where those could be real people.
 */
import assert from 'node:assert/strict';
import { dist } from './support/meta-db.mjs';
import { asUser as connectAs, dropRoles, liveSuite } from './support/live-pg.mjs';

const TEACHER = 't_lct_schaffner';
const LENA = 'u_lct_muster_lena';
const TIM = 'u_lct_meier_tim';
/** Students first: dropping the teacher while they still hold grants on a
 *  student's schema fails with 2BP01, and the grants go away with the schemas. */
const ALL = [LENA, TIM, TEACHER];
const PW = Object.fromEntries(ALL.map((r) => [r, `pw-${r}-x1`]));

// The lock is held for the whole file: this suite provisions, and so do the
// other four. See support/live-lock.mjs for what goes wrong without it.
const { LIVE, live, releaseLock } = await liveSuite('live catalog suite');

const { makeCatalogReader } = await import(dist('services/catalog.js'));
const { makeProvisioner } = await import(dist('services/provision.js'));
const { makeDb } = await import(dist('db/query.js'));
const { encryptSecret } = await import(dist('crypto/secretbox.js'));
const { teachAdminPool, getUserPool, closeAllPools } = await import(dist('db/pools.js'));

const teach = LIVE ? makeDb(teachAdminPool) : null;
const prov = LIVE ? makeProvisioner(teach) : null;

/**
 * A meta database that holds exactly the identities this suite needs.
 *
 * The real one is not the subject here — `pgIdentity` is covered by
 * services.test.mjs — and standing up a migrated meta database to test a
 * `pg_class` query would put the slowest part of the setup furthest from the
 * claim. The passwords go through the real `encryptSecret` so the real
 * decryption path still runs.
 */
function metaFor(userId, pgRole, role) {
  return {
    query: async () => ({
      rows: [
        {
          id: userId,
          role,
          state: 'active',
          pgRole,
          pgPasswordEnc: encryptSecret(PW[pgRole]),
          teacherRoles: [],
        },
      ],
      rowCount: 1,
    }),
  };
}

const readerFor = (userId, pgRole, role = 'student') =>
  makeCatalogReader({ db: metaFor(userId, pgRole, role), getPool: getUserPool });

/** Every statement here is fixture setup, so a failure should stop the test. */
const asUser = (role, sql) => connectAs(role, PW[role], sql);
/** `ALL` is already students-first, which is the order `dropRoles` requires. */
const teardown = () => dropRoles(ALL);

const schemaNames = (catalog) => catalog.schemas.map((s) => s.name);
const find = (catalog, name) => catalog.schemas.find((s) => s.name === name);

live('the catalog shows own tables and hides every other student’s', async () => {
  await teardown();
  await prov.ensureTeacher({ pgRole: TEACHER, pgPassword: PW[TEACHER], canLogin: true });
  for (const student of [LENA, TIM]) {
    await prov.ensureStudent({
      pgRole: student,
      pgPassword: PW[student],
      canLogin: true,
      teacherRoles: [TEACHER],
    });
  }

  await asUser(LENA, `CREATE TABLE kunden (id int PRIMARY KEY, name text NOT NULL)`);
  await asUser(TIM, `CREATE TABLE geheim (x int)`);

  const catalog = await readerFor(1, LENA).read(1);

  assert.equal(catalog.self, LENA);
  assert.ok(schemaNames(catalog).includes(LENA), 'own schema is listed');
  assert.equal(find(catalog, LENA).own, true);

  // The claim the whole file exists for. pg_class is world-readable, so this
  // only holds because of has_schema_privilege / has_table_privilege.
  assert.ok(!schemaNames(catalog).includes(TIM), `Lena must not see ${TIM}: ${schemaNames(catalog)}`);
  assert.ok(!schemaNames(catalog).includes(TEACHER), 'a student must not see the teacher’s schema');

  const kunden = find(catalog, LENA).tables.find((t) => t.name === 'kunden');
  assert.deepEqual(
    kunden.columns,
    [
      { name: 'id', type: 'integer', notNull: true },
      { name: 'name', type: 'text', notNull: true },
    ],
    'columns come back in ordinal order, with their real types',
  );
  assert.equal(kunden.kind, 'table');
});

live('a teacher sees their student’s schema; a view is labelled as one', async () => {
  await asUser(LENA, `CREATE VIEW reiche AS SELECT * FROM kunden WHERE id > 5`);

  const catalog = await readerFor(2, TEACHER, 'teacher').read(2);

  assert.ok(schemaNames(catalog).includes(LENA), 'the teacher reads their student’s schema');
  assert.equal(find(catalog, LENA).own, false, 'but it is not their own');
  assert.equal(find(catalog, TEACHER).own, true);

  const kinds = Object.fromEntries(find(catalog, LENA).tables.map((t) => [t.name, t.kind]));
  assert.deepEqual(kinds, { kunden: 'table', reiche: 'view' });
});

live('a readable schema with nothing in it is still listed', async () => {
  // The regression this pins: the query used to be driven from pg_class, so a
  // schema holding no readable relation produced no rows and vanished. For a
  // teacher that made "my student has no tables yet" and "I have lost my grant
  // on my student" render as the same thing — nothing at all.
  await asUser(LENA, `DROP VIEW reiche; DROP TABLE kunden`);

  const own = await readerFor(1, LENA).read(1);
  assert.ok(schemaNames(own).includes(LENA), 'an emptied schema is still listed for its owner');
  assert.deepEqual(find(own, LENA).tables, []);

  const teacher = await readerFor(2, TEACHER, 'teacher').read(2);
  assert.ok(
    schemaNames(teacher).includes(LENA),
    `the teacher still sees the empty schema: ${schemaNames(teacher)}`,
  );
});

live('a never-analysed table reports no row estimate rather than zero', async () => {
  await asUser(LENA, `CREATE TABLE frisch (x int); INSERT INTO frisch VALUES (1), (2), (3)`);

  const catalog = await readerFor(1, LENA).read(1);
  const frisch = find(catalog, LENA).tables.find((t) => t.name === 'frisch');

  // reltuples is -1 until ANALYZE runs. Reporting that as 0 would tell a
  // student their three rows are not there.
  assert.equal(frisch.estimatedRows, null, 'unanalysed means unknown, not empty');

  await asUser(LENA, `ANALYZE frisch`);
  const after = await readerFor(1, LENA).read(1);
  assert.equal(find(after, LENA).tables.find((t) => t.name === 'frisch').estimatedRows, 3);
});

live('teardown', async () => {
  await teardown();
  await closeAllPools();
  await releaseLock();
});
