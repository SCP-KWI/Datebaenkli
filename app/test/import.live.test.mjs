/**
 * CSV upload against a REAL PostgreSQL server.
 *
 * `csv.test.mjs` already pins what the file *says*. This suite exists for the
 * three claims that only a real server can answer, and that a mock would have
 * reported as passing while being wrong:
 *
 *   - the table lands in the caller's **own** schema and nowhere else, whatever
 *     the student typed into the name box;
 *   - the values Postgres actually stores are the ones the preview promised —
 *     `03.04.2025` is 3 April, not 4 March, which is a difference no assertion
 *     about our own coercion output can catch because both sides of it would be
 *     our own code;
 *   - a failed import leaves **no** table, not a half-filled one.
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
 *     node --test test/import.live.test.mjs
 *
 * Creates and destroys roles prefixed `t_lit` / `u_lit`. Do NOT point it at an
 * instance where those could be real people.
 */
import assert from 'node:assert/strict';
import { dist } from './support/meta-db.mjs';
import { asUser as connectAs, dropRoles, liveSuite } from './support/live-pg.mjs';

const TEACHER = 't_lit_schaffner';
const LENA = 'u_lit_muster_lena';
const TIM = 'u_lit_meier_tim';
/** Students first: dropping the teacher while they hold grants on a student's
 *  schema fails with 2BP01, and the grants go away with the schemas. */
const ALL = [LENA, TIM, TEACHER];
const PW = Object.fromEntries(ALL.map((r) => [r, `pw-${r}-x1`]));

// The lock is held for the whole file: this suite provisions, and so do the
// other four. See support/live-lock.mjs for what goes wrong without it.
const { LIVE, live, releaseLock } = await liveSuite('live import suite');

const { makeImporter } = await import(dist('services/import.js'));
const { makeQuotaGuard } = await import(dist('services/quota.js'));
const { makeProvisioner } = await import(dist('services/provision.js'));
const { makeDb } = await import(dist('db/query.js'));
const { encryptSecret } = await import(dist('crypto/secretbox.js'));
const { teachAdminPool, getUserPool, closeAllPools } = await import(dist('db/pools.js'));

const teach = LIVE ? makeDb(teachAdminPool) : null;
const prov = LIVE ? makeProvisioner(teach) : null;

/**
 * A meta database holding exactly the identity under test, which also records
 * the `query_log` INSERT so the last test can assert it happened.
 *
 * Standing up a migrated meta database to test a `CREATE TABLE` would put the
 * slowest part of the setup furthest from the claim; `pgIdentity` is already
 * covered by services.test.mjs. The password goes through the real
 * `encryptSecret` so the real decryption path still runs.
 */
function metaFor(userId, pgRole, role = 'student') {
  const logged = [];
  return {
    logged,
    query: async (sql, params) => {
      if (sql.includes('query_log')) {
        logged.push(params);
        return { rows: [], rowCount: 0 };
      }
      return {
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
      };
    },
  };
}

/**
 * `quotaBytes` defaults to a gigabyte so the existing cases are unaffected; the
 * quota tests pass a small one. That is why `makeQuotaGuard` takes the limit as
 * a parameter instead of reading `config` — filling 50 MB to watch a refusal
 * would put the slowest possible setup in front of the simplest claim.
 */
function importerFor(userId, pgRole, role = 'student', quotaBytes = 1024 ** 3) {
  const db = metaFor(userId, pgRole, role);
  const quota = makeQuotaGuard(teach, quotaBytes);
  return { importer: makeImporter({ db, quota, getPool: getUserPool }), db, quota };
}

/**
 * The assertions here read a table back; a failure to connect or to read is a
 * broken fixture and not a result, so this is the throwing form.
 */
const asUser = (role, sql) => connectAs(role, PW[role], sql);

/** Scoped to this suite's own prefix — see HANDOFF §4j. */
async function tablesOf(schema) {
  const { rows } = await teach.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
    [schema],
  );
  return rows.map((r) => r.tablename);
}

/** `ALL` is already students-first, which is the order `dropRoles` requires. */
const teardown = () => dropRoles(ALL);

const KUNDEN = [
  'Kunden-Nr;Name;Umsatz;Aktiv;Eintritt',
  "1;Müller AG;1'234,50;ja;03.04.2025",
  '2;Meier GmbH;9,90;nein;31.12.2024',
].join('\r\n');

const COLUMNS = [
  { name: 'kunden_nr', type: 'integer' },
  { name: 'name', type: 'text' },
  { name: 'umsatz', type: 'numeric' },
  { name: 'aktiv', type: 'boolean' },
  { name: 'eintritt', type: 'date' },
];

live('setup', async () => {
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
});

live('an import lands in the caller’s own schema, with the inferred types', async () => {
  const { importer, db } = importerFor(1, LENA);
  const outcome = await importer.run(1, {
    csv: KUNDEN,
    table: 'Kunden 2025',
    columns: COLUMNS,
    delimiter: ';',
    hasHeader: true,
    replace: false,
  });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.table, `${LENA}.kunden_2025`);
  assert.equal(outcome.rowCount, 2);

  assert.deepEqual(await tablesOf(LENA), ['kunden_2025']);
  assert.deepEqual(await tablesOf(TIM), [], 'nothing landed in another student’s schema');

  // Asked *as Lena*, not from the admin pool. `information_schema` shows only
  // what the current user has a privilege on, and `dbk_app` holds student roles
  // NOINHERIT (HANDOFF §4a) — so the same query from `teach` comes back empty
  // and would read as "the import created no columns".
  const { rows } = await asUser(
    LENA,
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = '${LENA}' AND table_name = 'kunden_2025' ORDER BY ordinal_position`,
  );
  assert.deepEqual(rows, [
    { column_name: 'kunden_nr', data_type: 'integer' },
    { column_name: 'name', data_type: 'text' },
    { column_name: 'umsatz', data_type: 'numeric' },
    { column_name: 'aktiv', data_type: 'boolean' },
    { column_name: 'eintritt', data_type: 'date' },
  ]);

  // The import is a thing the student did to their own database, so phase 4's
  // live lesson view has to be able to see it.
  assert.equal(db.logged.length, 1);
  assert.match(db.logged[0][1], /^CREATE TABLE/);
  assert.equal(db.logged[0][3], 2, 'the row count is the rows imported');
});

live('the Swiss date is stored as the day the student meant', async () => {
  // The claim the coercion layer exists for. Postgres's default DateStyle is
  // `ISO, MDY`, under which `03.04.2025` parses *without error* as March 4th —
  // so this can only be checked by asking the server what it kept.
  const { rows } = await asUser(
    LENA,
    `SELECT kunden_nr, name, umsatz, aktiv, to_char(eintritt, 'YYYY-MM-DD') AS eintritt
       FROM kunden_2025 ORDER BY kunden_nr`,
  );

  assert.deepEqual(rows, [
    { kunden_nr: 1, name: 'Müller AG', umsatz: '1234.50', aktiv: true, eintritt: '2025-04-03' },
    { kunden_nr: 2, name: 'Meier GmbH', umsatz: '9.90', aktiv: false, eintritt: '2024-12-31' },
  ]);
});

live('a second import of the same name is a conflict, not a silent overwrite', async () => {
  const { importer } = importerFor(1, LENA);
  await assert.rejects(
    () =>
      importer.run(1, {
        csv: KUNDEN,
        table: 'kunden_2025',
        columns: COLUMNS,
        delimiter: ';',
        hasHeader: true,
        replace: false,
      }),
    (err) => err.code === 'table_exists',
  );

  // And the original survived the attempt untouched.
  const { rows } = await asUser(LENA, `SELECT count(*)::int AS n FROM kunden_2025`);
  assert.equal(rows[0].n, 2);
});

live('replace drops and rebuilds', async () => {
  const { importer } = importerFor(1, LENA);
  const outcome = await importer.run(1, {
    csv: 'Kunden-Nr;Name;Umsatz;Aktiv;Eintritt\n7;Neu AG;1,00;ja;01.01.2026',
    table: 'kunden_2025',
    columns: COLUMNS,
    delimiter: ';',
    hasHeader: true,
    replace: true,
  });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const { rows } = await asUser(LENA, `SELECT kunden_nr FROM kunden_2025`);
  assert.deepEqual(rows, [{ kunden_nr: 7 }]);
});

live('a name cannot reach out of the caller’s own schema', async () => {
  // `u_lit_meier_tim.beute` folds to one identifier and is created at home.
  // The qualification in import.ts is ours, not the student's.
  const { importer } = importerFor(1, LENA);
  const outcome = await importer.run(1, {
    csv: 'a\n1',
    table: `${TIM}.beute`,
    columns: [{ name: 'a', type: 'integer' }],
    delimiter: ';',
    hasHeader: true,
    replace: false,
  });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.table, `${LENA}.${TIM}_beute`);
  assert.deepEqual(await tablesOf(TIM), [], 'Tim’s schema is untouched');

  await asUser(LENA, `DROP TABLE ${TIM}_beute`);
});

live('a type the data does not fit is reported per cell, and creates nothing', async () => {
  const { importer, db } = importerFor(1, LENA);
  const outcome = await importer.run(1, {
    csv: 'menge\n5\nviele\n7\n\nauch viele',
    table: 'lager',
    columns: [{ name: 'menge', type: 'integer' }],
    delimiter: ';',
    hasHeader: true,
    replace: false,
  });

  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.errors, [
    { line: 3, column: 'menge', value: 'viele', expected: 'integer' },
    { line: 6, column: 'menge', value: 'auch viele', expected: 'integer' },
  ]);

  assert.ok(!(await tablesOf(LENA)).includes('lager'), 'no table for a rejected import');
  // Rejected before a connection was ever opened, so there is nothing to log.
  assert.equal(db.logged.length, 0);
});

live('a failure part way through leaves no table at all', async () => {
  // A view on the old table blocks `DROP TABLE` (no CASCADE, deliberately), so
  // the replace fails *after* BEGIN. The transaction is what makes the outcome
  // "nothing changed" rather than "your table is gone and the new one is
  // half-written" — which is the state a student would most plausibly mistake
  // for success.
  await asUser(LENA, `CREATE VIEW top_kunden AS SELECT * FROM kunden_2025`);

  const { importer } = importerFor(1, LENA);
  const outcome = await importer.run(1, {
    csv: 'Kunden-Nr;Name;Umsatz;Aktiv;Eintritt\n9;Ersatz AG;2,00;ja;02.02.2026',
    table: 'kunden_2025',
    columns: COLUMNS,
    delimiter: ';',
    hasHeader: true,
    replace: true,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, '2BP01', 'Postgres refused the drop, and said why');

  const { rows } = await asUser(LENA, `SELECT kunden_nr FROM kunden_2025`);
  assert.deepEqual(rows, [{ kunden_nr: 7 }], 'the original table is exactly as it was');

  await asUser(LENA, `DROP VIEW top_kunden`);
});

live('an import larger than one INSERT batch arrives whole', async () => {
  // 2500 rows against a 1000-row statement cap: three batches, one transaction.
  const rows = Array.from({ length: 2500 }, (_, i) => `${i};Zeile ${i}`).join('\n');
  const { importer } = importerFor(1, LENA);
  const outcome = await importer.run(1, {
    csv: `nr;text\n${rows}`,
    table: 'viele',
    columns: [
      { name: 'nr', type: 'integer' },
      { name: 'text', type: 'text' },
    ],
    delimiter: ';',
    hasHeader: true,
    replace: false,
  });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.rowCount, 2500);

  const { rows: check } = await asUser(
    LENA,
    `SELECT count(*)::int AS n, min(nr) AS lo, max(nr) AS hi FROM viele`,
  );
  assert.deepEqual(check[0], { n: 2500, lo: 0, hi: 2499 });
});

live('blank cells become NULL rather than empty strings', async () => {
  const { importer } = importerFor(1, LENA);
  const outcome = await importer.run(1, {
    csv: 'a;b;c\n1;;\n;2;x',
    table: 'luecken',
    columns: [
      { name: 'a', type: 'integer' },
      { name: 'b', type: 'integer' },
      { name: 'c', type: 'text' },
    ],
    delimiter: ';',
    hasHeader: true,
    replace: false,
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));

  const { rows } = await asUser(LENA, `SELECT a, b, c FROM luecken ORDER BY a NULLS LAST`);
  assert.deepEqual(rows, [
    { a: 1, b: null, c: null },
    { a: null, b: 2, c: 'x' },
  ]);
});

live('a schema over quota refuses the import before it writes anything', async () => {
  // One byte of quota. Lena's schema already holds several tables, so she is
  // over it before the file is even looked at — which is the point: the refusal
  // has to happen without a connection, without a CREATE TABLE, and without a
  // `query_log` row claiming she ran something.
  const { importer, db, quota } = importerFor(1, LENA, 'student', 1);
  const before = await tablesOf(LENA);

  // Asserted first and separately: the refusal below would also fire on a
  // measurement of zero, which is exactly what a `dbk_app` read through
  // `information_schema` returns for a student's schema (HANDOFF §4o). A test
  // that cannot tell "over quota" from "cannot see anything" proves nothing.
  const { bytes, overQuota } = await quota.usage(LENA);
  assert.ok(bytes > 0, `the admin handle read a real size, not 0 (got ${bytes})`);
  assert.equal(overQuota, true);

  await assert.rejects(
    () =>
      importer.run(1, {
        csv: 'a\n1',
        table: 'zu_gross',
        columns: [{ name: 'a', type: 'integer' }],
        delimiter: ';',
        hasHeader: true,
        replace: false,
      }),
    (err) => {
      assert.equal(err.code, 'quota_exceeded');
      // The size came from a real `pg_total_relation_size` sum read as
      // `dbk_app` about a student's schema — the thing HANDOFF §4o says
      // `information_schema` would have answered 0 for.
      assert.match(err.message, /Your database holds \d+\.\d MB/);
      return true;
    },
  );

  assert.deepEqual(await tablesOf(LENA), before, 'nothing was created');
  assert.equal(db.logged.length, 0, 'and nothing was logged as having run');
});

live('replacing a table credits the space it is about to free', async () => {
  // The refusal that would be visibly wrong: re-uploading a corrected file over
  // the same table nets out to roughly zero, and a student at the limit must
  // not be told to delete something to make room for bytes they already own.
  const { quota } = importerFor(1, LENA);
  const { bytes } = await quota.usage(LENA);
  const exact = importerFor(1, LENA, 'student', bytes).importer;

  const request = {
    csv: 'nr;text\n1;klein',
    table: 'viele',
    columns: [
      { name: 'nr', type: 'integer' },
      { name: 'text', type: 'text' },
    ],
    delimiter: ';',
    hasHeader: true,
  };

  // Same file, same quota, same table — the only difference is whether the old
  // copy's bytes are counted as coming back.
  await assert.rejects(
    () => exact.run(1, { ...request, table: 'noch_mehr', replace: false }),
    (err) => err.code === 'quota_exceeded',
  );

  const outcome = await exact.run(1, { ...request, replace: true });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));

  const { rows } = await asUser(LENA, `SELECT count(*)::int AS n FROM viele`);
  assert.equal(rows[0].n, 1, 'the replacement is the small file, not the 2500-row one');
});

live('teardown', async () => {
  await teardown();
  await closeAllPools();
  await releaseLock();
});
