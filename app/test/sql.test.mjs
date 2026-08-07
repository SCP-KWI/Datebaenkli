/**
 * Migration checks, in two layers.
 *
 *  1. PARSE  — every .sql file through libpg-query, the real PostgreSQL
 *              grammar. Catches syntax errors without a server.
 *  2. EXECUTE — the migrations run in PGlite (Postgres compiled to WASM) and
 *              the resulting data is asserted. Catches what parsing cannot:
 *              wrong column types, broken FK targets, CHECK violations,
 *              non-deterministic seed data.
 *
 * KNOWN GAPS — neither layer covers these, they need a real server:
 *   - CREATE ROLE / GRANT / REVOKE / ALTER DEFAULT PRIVILEGES (PGlite is
 *     single-user, so grants are stripped before execution below)
 *   - the db/init bootstrap as a whole (roles, databases)
 *   - per-role SET statement_timeout etc.
 *   - PGlite tracks a newer Postgres major than the server's 17; everything
 *     used here is long-stable SQL, but the versions are not identical.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pgQuery from 'libpg-query';

const SQL_ROOT = join(import.meta.dirname, '..', 'src', 'db', 'sql');
const BOOTSTRAP = join(import.meta.dirname, '..', '..', 'db', 'init', '00-bootstrap.sh');

const read = (p) => readFileSync(join(SQL_ROOT, p), 'utf8');

function migrationFiles() {
  const out = [];
  for (const target of readdirSync(SQL_ROOT)) {
    for (const f of readdirSync(join(SQL_ROOT, target))) {
      if (f.endsWith('.sql')) out.push(`${target}/${f}`);
    }
  }
  return out.sort();
}

/** PGlite has no roles; drop grant machinery so the rest can be executed. */
const stripGrants = (sql) =>
  sql
    .replace(/^GRANT .*?;$/gms, '')
    .replace(/^REVOKE .*?;$/gms, '')
    .replace(/^ALTER DEFAULT PRIVILEGES[\s\S]*?;$/gm, '');

// --- layer 1: parse ----------------------------------------------------------

for (const file of migrationFiles()) {
  test(`parse: ${file}`, async () => {
    const tree = await pgQuery.parse(read(file));
    assert.ok(tree.stmts.length > 0, 'should contain at least one statement');
  });
}

test('parse: db/init bootstrap heredocs', async () => {
  const shell = readFileSync(BOOTSTRAP, 'utf8');
  const blocks = [...shell.matchAll(/<<-'EOSQL'\n([\s\S]*?)\nEOSQL/g)].map((m) => m[1]);
  // Four: the databases, the two `public` schemas, the meta lockdown, and the
  // large-object revokes. The count is asserted rather than just iterated so
  // that a block someone deletes shows up here instead of silently ceasing to
  // be checked — which is the whole point of parsing them at all.
  assert.equal(blocks.length, 4, 'expected four SQL heredocs in the bootstrap script');
  for (const block of blocks) {
    // psql's :'var' interpolation is not SQL; substitute before parsing.
    const tree = await pgQuery.parse(block.replace(/:'app_pw'/g, "'placeholder'"));
    assert.ok(tree.stmts.length > 0);
  }
});

// --- layer 2: execute --------------------------------------------------------

/**
 * Every migration for one target, in filename order — the rule `db/migrate.ts`
 * applies, rather than a list to keep in step with the directory. A file that a
 * hardcoded list forgot is a migration this layer never executes, which is
 * precisely the thing it exists to catch.
 */
async function fresh(target) {
  const db = new PGlite();
  await db.waitReady;
  for (const file of migrationFiles().filter((f) => f.startsWith(`${target}/`))) {
    await db.exec(stripGrants(read(file)));
  }
  return db;
}

const freshMeta = () => fresh('meta');
const freshTeach = () => fresh('teach');

test('meta: schema creates the expected tables', async () => {
  const db = await freshMeta();
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' ORDER BY table_name`,
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ['app_user', 'audit_log', 'class', 'class_member', 'exercise',
     'exercise_assignment', 'exercise_source', 'exercise_workspace',
     'query_log', 'session', 'setting', 'submission'],
  );
});

test('meta: 003 drops the auto-grading columns rather than leaving them', async () => {
  // The point of the assertion is the *absence*. 003's header argues that an
  // unused column with no writer and no UI is a decoy, and a decoy is exactly
  // what a later reader would re-grow a feature around.
  const db = await freshMeta();
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'exercise' ORDER BY column_name`,
  );
  const columns = rows.map((r) => r.column_name);
  for (const gone of ['solution_sql', 'compare', 'published', 'setup_sql']) {
    assert.ok(!columns.includes(gone), `exercise.${gone} should have been dropped by 003`);
  }
  const { rows: types } = await db.query(
    `SELECT typname FROM pg_type WHERE typname = 'compare_mode'`,
  );
  assert.equal(types.length, 0);
});

test('meta: a workspace schema name must look like one', async () => {
  // The CHECK is the second of db/ident.ts's two independent guards, restated in
  // the database. A role name must fail it: `u_…` is the string this constraint
  // exists to keep out of a column that gets interpolated into `DROP SCHEMA`.
  const db = await freshMeta();
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, pg_role)
                 VALUES ('lena','Lena','student','x','u_k3a_muster_lena')`);
  await db.exec(`INSERT INTO exercise (teacher_id, title)
                 SELECT id, 'Kunden' FROM app_user WHERE username = 'lena'`);

  const insert = (schema) =>
    db.query(
      `INSERT INTO exercise_workspace (exercise_id, user_id, schema_name)
       SELECT (SELECT id FROM exercise), (SELECT id FROM app_user), $1`,
      [schema],
    );

  await insert('x1_u_k3a_muster_lena');
  for (const bad of ['u_k3a_muster_lena', 'public', 'x_u_lena', 'X1_U_LENA']) {
    await assert.rejects(() => insert(bad), /exercise_workspace_name_ck/);
  }
});

test('meta: two hand-ins cannot both be attempt 2', async () => {
  const db = await freshMeta();
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, pg_role)
                 VALUES ('lena','Lena','student','x','u_k3a_muster_lena')`);
  await db.exec(`INSERT INTO exercise (teacher_id, title)
                 SELECT id, 'Kunden' FROM app_user WHERE username = 'lena'`);
  const submit = (attempt) =>
    db.query(
      `INSERT INTO submission (exercise_id, user_id, sql_text, attempt)
       SELECT (SELECT id FROM exercise), (SELECT id FROM app_user), 'SELECT 1', $1`,
      [attempt],
    );
  await submit(1);
  await submit(2);
  await assert.rejects(() => submit(2), /submission_attempt_key/);
});

test('meta: admins have no pg_role, everyone else must', async () => {
  const db = await freshMeta();
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                 VALUES ('admin','Admin','admin','x')`);
  await assert.rejects(
    () => db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, pg_role)
                   VALUES ('a2','A2','admin','x','u_nope')`),
    /app_user_pg_role_ck/,
  );
  await assert.rejects(
    () => db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                   VALUES ('s1','S1','student','x')`),
    /app_user_pg_role_ck/,
  );
});

test('meta: locale is restricted to supported values', async () => {
  const db = await freshMeta();
  await assert.rejects(
    () => db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, locale)
                   VALUES ('s2','S2','student','x','fr')`),
    /locale/,
  );
});

test('meta: username unique case-insensitively, reusable after deletion', async () => {
  const db = await freshMeta();
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                 VALUES ('admin','Admin','admin','x')`);
  await assert.rejects(
    () => db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                   VALUES ('ADMIN','Dup','admin','x')`),
    /app_user_username_key/,
  );
  await db.exec(`UPDATE app_user SET state='deleted' WHERE username='admin'`);
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                 VALUES ('admin','Reused','admin','x')`);
});

test('meta: class codes must be lowercase slugs', async () => {
  const db = await freshMeta();
  // teachers are non-admin, so app_user_pg_role_ck requires a pg_role
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, pg_role)
                 VALUES ('t','T','teacher','x','t_schaffner')`);
  await assert.rejects(
    () => db.exec(`INSERT INTO class (code, name, teacher_id)
                   VALUES ('K3a!','Bad',(SELECT id FROM app_user LIMIT 1))`),
    /class_code_ck/,
  );
});

test('demo: row counts are as designed', async () => {
  const db = await freshTeach();
  const { rows } = await db.query(`
    SELECT 'kantone' t, count(*)::int c FROM demo.kantone
    UNION ALL SELECT 'gemeinden', count(*)::int FROM demo.gemeinden
    UNION ALL SELECT 'faecher', count(*)::int FROM demo.faecher
    UNION ALL SELECT 'schuelerinnen', count(*)::int FROM demo.schuelerinnen
    UNION ALL SELECT 'noten', count(*)::int FROM demo.noten
    UNION ALL SELECT 'artikel', count(*)::int FROM demo.artikel
    UNION ALL SELECT 'bestellungen', count(*)::int FROM demo.bestellungen`);
  const c = Object.fromEntries(rows.map((r) => [r.t, r.c]));
  assert.equal(c.kantone, 26, 'Switzerland has 26 cantons');
  assert.equal(c.schuelerinnen, 30);
  assert.equal(c.faecher, 8);
  assert.equal(c.noten, 30 * 8 * 3, 'three marks per student per subject');
  assert.equal(c.bestellungen, 60);
});

test('demo: Noten land on exact half steps (numeric(2,1) cannot hold quarters)', async () => {
  const db = await freshTeach();
  const { rows } = await db.query('SELECT DISTINCT note FROM demo.noten ORDER BY note');
  assert.deepEqual(rows.map((r) => Number(r.note)), [3, 3.5, 4, 4.5, 5, 5.5, 6]);
});

test('demo: no orphaned foreign keys', async () => {
  const db = await freshTeach();
  const { rows } = await db.query(`
    SELECT
      (SELECT count(*)::int FROM demo.gemeinden g
        LEFT JOIN demo.kantone k ON k.id=g.kanton_id WHERE k.id IS NULL) AS gem,
      (SELECT count(*)::int FROM demo.schuelerinnen s
        LEFT JOIN demo.gemeinden g ON g.id=s.gemeinde_id WHERE g.id IS NULL) AS sch,
      (SELECT count(*)::int FROM demo.bestellpositionen p
        LEFT JOIN demo.artikel a ON a.id=p.artikel_id WHERE a.id IS NULL) AS pos`);
  assert.deepEqual(rows[0], { gem: 0, sch: 0, pos: 0 });
});

test('demo: every canton has at least one Gemeinde, so JOINs are interesting', async () => {
  const db = await freshTeach();
  const { rows } = await db.query(
    `SELECT count(*)::int c FROM demo.kantone k
     WHERE NOT EXISTS (SELECT 1 FROM demo.gemeinden g WHERE g.kanton_id=k.id)`);
  assert.equal(rows[0].c, 0);
});

test('demo: generated data is identical across deployments', async () => {
  // v2 exercises compare a student result to a reference solution, so two
  // installations must agree on what the data is.
  const fingerprint = async (db) => {
    const { rows } = await db.query(`
      SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
        SELECT id||':'||schuelerin_id||':'||fach_id||':'||note||':'||datum AS x FROM demo.noten
        UNION ALL
        SELECT 'b'||id||':'||schuelerin_id||':'||datum||':'||status FROM demo.bestellungen
        UNION ALL
        SELECT 'p'||bestellung_id||':'||artikel_id||':'||menge||':'||einzelpreis
          FROM demo.bestellpositionen
      ) s`);
    return rows[0].h;
  };
  assert.equal(await fingerprint(await freshTeach()), await fingerprint(await freshTeach()));
});

test('demo: a representative lesson query works', async () => {
  const db = await freshTeach();
  const { rows } = await db.query(`
    SELECT k.name AS kanton, count(DISTINCT s.id)::int AS lernende,
           round(avg(n.note), 2) AS schnitt
    FROM demo.kantone k
    JOIN demo.gemeinden g ON g.kanton_id = k.id
    JOIN demo.schuelerinnen s ON s.gemeinde_id = g.id
    JOIN demo.noten n ON n.schuelerin_id = s.id
    GROUP BY k.name HAVING count(DISTINCT s.id) > 1
    ORDER BY schnitt DESC`);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(Number(r.schnitt) >= 1 && Number(r.schnitt) <= 6);
  }
});
