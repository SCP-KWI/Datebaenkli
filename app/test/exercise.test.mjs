/**
 * The exercise service against migrated PGlite — phase 9.
 *
 * The same split every other service test in this repo makes, and it is worth
 * restating because the line falls in an awkward place here. `services/exercise.ts`
 * does two things: it keeps a set of meta-database rows in order, and it
 * materialises a schema in the *teaching* database. Only the first is testable
 * without a cluster — PGlite stands in for the meta database and cannot execute
 * a `GRANT`, let alone `CREATE SCHEMA … AUTHORIZATION`.
 *
 * So this file covers the bookkeeping, with a recording provisioner underneath:
 * which name gets reserved, what a take-back decides to drop, whether attempt
 * numbers are assigned rather than derived, what the download says. The other
 * half — that a workspace is really isolated, that a reset drops only itself —
 * is `test/exercise.live.test.mjs`, where it can actually be asked.
 *
 * `renderBundle` and `downloadName` are pure and are tested here directly, since
 * that is where they are cheapest to pin.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { dist, freshMeta } from './support/meta-db.mjs';

const users = await import(dist('services/users.js'));
const classes = await import(dist('services/classes.js'));
const provision = await import(dist('services/provision.js'));
const exerciseSvc = await import(dist('services/exercise.js'));
const quotaSvc = await import(dist('services/quota.js'));

let prov = provision.recordingProvisioner();
const callsTo = (op) => prov.calls.filter((c) => c.op === op).map((c) => c.args);

/**
 * A pool that refuses to hand out a connection.
 *
 * Every path that would open one is a path this file cannot test anyway, so the
 * refusal is load-bearing rather than a stub: a case that reaches it is a case
 * that has wandered into the live suite's territory, and it should say so by
 * failing here rather than by quietly appearing to pass.
 */
const noPool = () => ({
  connect: () => {
    throw new Error('this suite has no teaching database — see the header');
  },
});

/** A quota guard that never refuses. The real one is measured in the live suite. */
const openQuota = {
  quotaBytes: 50 * 1024 * 1024,
  usage: async () => ({ bytes: 0, quotaBytes: 50 * 1024 * 1024, overQuota: false }),
  relationBytes: async () => 0,
  check: async () => {},
};

async function setup(options = {}) {
  prov = provision.recordingProvisioner(options);
  const { db, adminId } = await freshMeta();
  const { user: teacher } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Petra',
    lastName: 'Lehrer',
  });
  const klass = await classes.createClass(db, adminId, {
    code: 'k3a',
    name: '3a Wirtschaft',
    teacherId: teacher.id,
  });
  const created = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
    { firstName: 'Tim', lastName: 'Meier' },
  ]);
  const service = exerciseSvc.makeExerciseService({
    db,
    prov,
    quota: openQuota,
    getPool: noPool,
  });
  return {
    db,
    adminId,
    teacher,
    klass,
    service,
    lena: created[0].user,
    tim: created[1].user,
  };
}

const CSV = 'name;ort;umsatz\nMüller AG;Zürich;1234,50\nSuter;Bern;980,00\n';
const COLUMNS = [
  { name: 'name', type: 'text' },
  { name: 'ort', type: 'text' },
  { name: 'umsatz', type: 'numeric' },
];

// --- authoring ---------------------------------------------------------------

test('an exercise starts empty and belongs to the teacher who made it', async () => {
  const { service, teacher } = await setup();
  const created = await service.createExercise(teacher.id, { title: 'Kunden', taskMd: '# Los' });

  assert.equal(created.title, 'Kunden');
  assert.equal(created.teacherId, teacher.id);

  const detail = await service.detail(created.id);
  assert.deepEqual(detail.sources, []);
  assert.deepEqual(detail.assignments, []);
});

test('sources keep the order they were added, and can be reordered', async () => {
  const { service, teacher } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });

  const a = await service.addSqlSource(teacher.id, id, { label: 'eins', sqlText: 'SELECT 1' });
  const b = await service.addSqlSource(teacher.id, id, { label: 'zwei', sqlText: 'SELECT 2' });
  const c = await service.addCsvSource(teacher.id, id, {
    label: 'kunden',
    csv: CSV,
    columns: COLUMNS,
  });

  const labels = async () => (await service.detail(id)).sources.map((s) => s.label);
  assert.deepEqual(await labels(), ['eins', 'zwei', 'kunden']);

  await service.reorderSources(id, [c.id, a.id, b.id]);
  assert.deepEqual(await labels(), ['kunden', 'eins', 'zwei']);
});

test('a CSV source stores the file and the confirmed columns, not generated SQL', async () => {
  // The property, not an implementation detail: generating INSERT text would be
  // this app building *data* by concatenation, which import.ts refuses to do.
  const { service, teacher } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  const source = await service.addCsvSource(teacher.id, id, {
    label: 'Kunden Liste',
    csv: CSV,
    columns: COLUMNS,
  });

  assert.equal(source.kind, 'csv');
  assert.equal(source.label, 'kunden_liste', 'the label is folded to a relation name');
  assert.equal(source.rowCount, 2);
  assert.deepEqual(source.columns, COLUMNS);

  const full = await service.getSource(id, source.id);
  assert.equal(full.csvText, CSV);
  assert.equal(full.sqlText, undefined);
});

test('a CSV whose values do not fit the chosen types is refused at upload', async () => {
  // Refused *here* rather than at materialisation, because the person who can
  // fix it is looking at it now; the alternative fails in front of a class.
  const { service, teacher } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });

  await assert.rejects(
    () =>
      service.addCsvSource(teacher.id, id, {
        label: 'kunden',
        csv: CSV,
        columns: [
          { name: 'name', type: 'integer' },
          { name: 'ort', type: 'text' },
          { name: 'umsatz', type: 'numeric' },
        ],
      }),
    (err) => err.code === 'csv_types_rejected',
  );

  assert.deepEqual((await service.detail(id)).sources, [], 'nothing was stored');
});

test('an exercise is capped at MAX_SOURCES', async () => {
  const { service, teacher } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  for (let n = 0; n < exerciseSvc.MAX_SOURCES; n++) {
    await service.addSqlSource(teacher.id, id, { label: `t${n}`, sqlText: 'SELECT 1' });
  }
  await assert.rejects(
    () => service.addSqlSource(teacher.id, id, { label: 'zuviel', sqlText: 'SELECT 1' }),
    (err) => err.code === 'too_many_sources',
  );
});

// --- who may open what -------------------------------------------------------

test('a student may open only an exercise assigned to a class they are in', async () => {
  const { service, teacher, klass, lena } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });

  assert.equal(await service.mayOpen(lena.id, id), false, 'not distributed yet');
  await service.distribute(teacher.id, id, klass.id);
  assert.equal(await service.mayOpen(lena.id, id), true);
});

test('the author may open their own exercise without being in its class', async () => {
  // Otherwise a teacher can build a fixture and never run it, and the only way
  // to find out it is broken is a student's afternoon.
  const { service, teacher } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  assert.equal(await service.mayOpen(teacher.id, id), true);
});

// --- the workspace name ------------------------------------------------------

test('the workspace name is allocated once and reused', async () => {
  const { service, teacher, klass, lena } = await setup({ workspaceCreated: false });
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);

  const first = await service.openWorkspace(lena.id, id);
  assert.equal(first.schema, `x${id}_${lena.pgRole}`);
  assert.equal(first.materialised, false, 'the provisioner said the schema was already there');

  const second = await service.openWorkspace(lena.id, id);
  assert.equal(second.schema, first.schema, 'a second open must not allocate a second name');
});

test('opening an existing workspace does not replay the fixtures', async () => {
  // The bug this pins would wipe a student's work every time they came back to
  // the exercise, which is the single most destructive thing this feature could
  // plausibly do — and it would look exactly like "the reset button is stuck".
  const { service, teacher, klass, lena } = await setup({ workspaceCreated: false });
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.addCsvSource(teacher.id, id, { label: 'kunden', csv: CSV, columns: COLUMNS });
  await service.distribute(teacher.id, id, klass.id);

  // `noPool` throws, so reaching the materialisation path at all fails the test.
  const outcome = await service.openWorkspace(lena.id, id);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.materialised, false);
});

test('two students get two different schemas', async () => {
  const { service, teacher, klass, lena, tim } = await setup({ workspaceCreated: false });
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);

  const one = await service.openWorkspace(lena.id, id);
  const two = await service.openWorkspace(tim.id, id);
  assert.notEqual(one.schema, two.schema);
});

test('a workspace name is checked against the database’s own allow-list', async () => {
  // `exercise_workspace_name_ck` mirrors db/ident.ts. This asserts the service
  // produces something that satisfies it rather than trusting that it does.
  const { db, service, teacher, klass, lena } = await setup({ workspaceCreated: false });
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);
  await service.openWorkspace(lena.id, id);

  const { rows } = await db.query('SELECT schema_name FROM exercise_workspace');
  assert.match(rows[0].schema_name, /^x[0-9]+_[a-z0-9_]{1,58}$/);
  assert.ok(!/^[ut]_/.test(rows[0].schema_name), 'must not look like a role name');
});

// --- running SQL against one -------------------------------------------------

test('workspaceFor refuses an exercise that has not been opened', async () => {
  const { service, teacher, klass, lena } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);

  await assert.rejects(
    () => service.workspaceFor(lena.id, id),
    (err) => err.code === 'exercise_not_open',
  );
});

test('workspaceFor refuses somebody else’s exercise', async () => {
  const { db, adminId, service, teacher, klass, lena } = await setup({ workspaceCreated: false });
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);
  await service.openWorkspace(lena.id, id);

  // A student in a different class, under a different teacher.
  const { user: other } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Anna',
    lastName: 'Nord',
  });
  const otherClass = await classes.createClass(db, adminId, {
    code: 'k9z',
    name: 'Andere',
    teacherId: other.id,
  });
  const [outsider] = await users.createStudents(db, prov, other.id, otherClass.id, [
    { firstName: 'Ann', lastName: 'Alpha' },
  ]);

  await assert.rejects(
    () => service.workspaceFor(outsider.user.id, id),
    (err) => err.code === 'exercise_not_found',
    'and "not found" rather than "forbidden": there is nothing to confirm',
  );
});

// --- hand-ins ----------------------------------------------------------------

test('hand-ins are numbered, and a student may hand in more than once', async () => {
  const { service, teacher, klass, lena } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);

  const one = await service.submit(lena.id, id, { sqlText: 'SELECT 1' });
  const two = await service.submit(lena.id, id, { sqlText: 'SELECT 2', note: 'zweiter Versuch' });
  assert.equal(one.attempt, 1);
  assert.equal(two.attempt, 2);
  assert.equal(two.note, 'zweiter Versuch');

  const mine = await service.listSubmissions(id, { userId: lena.id });
  assert.deepEqual(
    mine.map((s) => s.attempt),
    [1, 2],
  );
});

test('two students number their hand-ins independently', async () => {
  const { service, teacher, klass, lena, tim } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);

  await service.submit(lena.id, id, { sqlText: 'SELECT 1' });
  const timsFirst = await service.submit(tim.id, id, { sqlText: 'SELECT 2' });
  assert.equal(timsFirst.attempt, 1, 'not 2 — the counter is per student');
});

test('a student who is not in the class cannot hand in', async () => {
  const { service, teacher, lena } = await setup();
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  // Never distributed.
  await assert.rejects(
    () => service.submit(lena.id, id, { sqlText: 'SELECT 1' }),
    (err) => err.code === 'exercise_not_found',
  );
});

// --- take-back and delete ----------------------------------------------------

test('taking an exercise back drops the workspaces and the hand-ins', async () => {
  const { db, service, teacher, klass, lena, tim } = await setup({ workspaceCreated: false });
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);
  await service.openWorkspace(lena.id, id);
  await service.openWorkspace(tim.id, id);
  await service.submit(lena.id, id, { sqlText: 'SELECT 1' });
  await service.submit(lena.id, id, { sqlText: 'SELECT 2' });

  const result = await service.takeBack(teacher.id, id, klass.id);
  assert.equal(result.workspaces, 2);
  assert.equal(result.submissions, 2);
  assert.deepEqual(result.failures, []);

  // The schemas were asked for by name — this is the assertion that the drop
  // was actually issued rather than only the rows deleted.
  assert.deepEqual(
    callsTo('dropWorkspace')
      .map(([, schema]) => schema)
      .sort(),
    [`x${id}_${lena.pgRole}`, `x${id}_${tim.pgRole}`].sort(),
  );

  const { rows: left } = await db.query('SELECT count(*)::int AS n FROM exercise_workspace');
  assert.equal(left[0].n, 0);
  assert.deepEqual((await service.detail(id)).assignments, []);
  assert.equal(await service.mayOpen(lena.id, id), false);
});

test('a workspace that will not drop keeps its row, so the next attempt retries it', async () => {
  // The direction that matters: rows without schemas self-heal on the next open,
  // schemas without rows are unreachable from any UI and sit on the disk.
  const { db, service, teacher, klass, lena } = await setup({
    workspaceCreated: false,
    failing: { dropWorkspace: 'schema busy' },
  });
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);
  await service.openWorkspace(lena.id, id);

  const result = await service.takeBack(teacher.id, id, klass.id);
  assert.equal(result.workspaces, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /schema busy/);

  const { rows } = await db.query('SELECT count(*)::int AS n FROM exercise_workspace');
  assert.equal(rows[0].n, 1, 'the row survives a failed drop');
});

test('deleting an exercise drops every class’s workspaces first', async () => {
  const { db, service, teacher, klass, lena } = await setup({ workspaceCreated: false });
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.addSqlSource(teacher.id, id, { label: 'a', sqlText: 'SELECT 1' });
  await service.distribute(teacher.id, id, klass.id);
  await service.openWorkspace(lena.id, id);
  await service.submit(lena.id, id, { sqlText: 'SELECT 1' });

  await service.deleteExercise(teacher.id, id);
  assert.equal(callsTo('dropWorkspace').length, 1);

  for (const table of ['exercise', 'exercise_source', 'exercise_workspace', 'submission']) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(rows[0].n, 0, `${table} should have been cascaded away`);
  }
});

test('a take-back is audited with what it destroyed', async () => {
  const { db, service, teacher, klass, lena } = await setup({ workspaceCreated: false });
  const { id } = await service.createExercise(teacher.id, { title: 'K', taskMd: '' });
  await service.distribute(teacher.id, id, klass.id);
  await service.openWorkspace(lena.id, id);
  await service.submit(lena.id, id, { sqlText: 'SELECT 1' });
  await service.takeBack(teacher.id, id, klass.id);

  const { rows } = await db.query(
    `SELECT detail FROM audit_log WHERE action = 'exercise_taken_back'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail.workspaces, 1);
  assert.equal(rows[0].detail.submissions, 1);
});

// --- what the teacher downloads ----------------------------------------------

const submission = (over = {}) => ({
  id: 1,
  exerciseId: 1,
  userId: 3,
  displayName: 'Lena Muster',
  username: 'u_k3a_muster_lena',
  attempt: 1,
  sqlText: 'SELECT 1;',
  note: null,
  createdAt: '2026-08-06T09:00:00.000Z',
  ...over,
});

test('a hand-in renders as a runnable .sql with the student in a comment', () => {
  const text = exerciseSvc.renderSubmission(submission(), 'Kunden');
  assert.match(text, /^-- =+\n-- Lena Muster \(u_k3a_muster_lena\)/);
  assert.match(text, /-- Abgabe 1 — 2026-08-06T09:00:00\.000Z/);
  assert.ok(text.trimEnd().endsWith('SELECT 1;'));
});

test('a multi-line note is commented on every line', () => {
  // Otherwise the second line of a note is a line of prose in a .sql file, and
  // the file stops being runnable the moment anyone tries.
  const text = exerciseSvc.renderSubmission(
    submission({ note: 'erste Zeile\nzweite Zeile' }),
    'Kunden',
  );
  for (const line of text.split('\n')) {
    if (line.includes('zweite Zeile')) assert.match(line, /^-- /);
  }
});

test('the class bundle counts students, not hand-ins', () => {
  const text = exerciseSvc.renderBundle(
    [
      submission({ id: 1, attempt: 1 }),
      submission({ id: 2, attempt: 2 }),
      submission({ id: 3, userId: 4, displayName: 'Tim Meier', username: 'u_k3a_meier_tim' }),
    ],
    { exerciseTitle: 'Kunden', className: 'k3a — 3a' },
  );
  assert.match(text, /3 Abgabe\(n\) von 2 Lernenden/);
  assert.match(text, /-- Klasse: k3a — 3a/);
});

test('a download filename is folded to something a filesystem accepts', () => {
  assert.equal(
    exerciseSvc.downloadName(['Bestellungen auswerten', 'u_k3a_muster_lena', '2']),
    'bestellungen-auswerten-u-k3a-muster-lena-2.sql',
  );
  // German is transliterated, not accent-stripped — `ß` has no decomposition,
  // so the obvious NFD version yields `gro-e` and this one yields `groesse`.
  assert.equal(exerciseSvc.downloadName(['Übung «Größe»']), 'uebung-groesse.sql');
  // A title that folds away entirely still has to produce a filename.
  assert.equal(exerciseSvc.downloadName(['中文']), 'abgaben.sql');
});

// --- the quota sees a student's whole disk -----------------------------------

test('the quota measures by owner, so a workspace counts against its student', async () => {
  // A stub Queryable rather than PGlite: this asserts the *shape* of the
  // question — one role in, every schema it owns measured — which is the thing
  // that would silently revert to "the schema named after them". The arithmetic
  // over real bytes is test/query.live.test.mjs's.
  const asked = [];
  const guard = quotaSvc.makeQuotaGuard(
    {
      query: async (text, values) => {
        asked.push({ text, values });
        return { rows: [{ bytes: '1000' }], rowCount: 1 };
      },
    },
    50_000,
  );

  await guard.usage('u_k3a_muster_lena');
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].values, ['u_k3a_muster_lena']);
  assert.match(asked[0].text, /r\.rolname = \$1/, 'measured by owner, not only by schema name');
  assert.match(asked[0].text, /n\.nspname = \$1/, 'and by name as the safety net');
});
