/**
 * Exercises — phase 9.
 *
 * A teacher builds a set of tables and a task, hands it to a class, and every
 * student gets their own copy to work in and their own way to hand something
 * back.
 *
 * ## Where a student's copy lives
 *
 * In its own schema, owned by that student: `x7_u_k3a_muster_lena`. Not
 * prefixed tables inside their playground schema, and the difference is what
 * makes three of the four requirements fall out of the design rather than be
 * implemented:
 *
 *   - **isolation** is the same Postgres-enforced thing as everywhere else, not
 *     a new rule written here — the schema has an owner and nobody else has
 *     USAGE on it;
 *   - **"reset just this exercise"** is `DROP SCHEMA`, exact by construction,
 *     rather than a prefix match over table names that a student can break by
 *     renaming a table;
 *   - **the schema browser shows it** with no change at all, because
 *     `services/catalog.ts` lists what the caller can read and this is theirs.
 *
 * The name is allocated once and stored (`exercise_workspace`), never derived at
 * the call site — see that table's comment in `meta/003_exercises.sql` for why a
 * derived-and-clamped name is an isolation bug rather than a cosmetic one.
 *
 * ## This file builds no SQL by string
 *
 * CLAUDE.md reserves that for `provision.ts` and `import.ts`, and phase 9 adds
 * no third. Everything here that would need it is delegated:
 *
 *   - the schema itself (`CREATE SCHEMA … AUTHORIZATION`, the drop, the
 *     teacher's read grant) runs as `dbk_app`, which is `provision.ts`'s hazard
 *     class, so it lives there as `createWorkspace` / `dropWorkspace`;
 *   - a CSV fixture becomes a table through `import.ts`'s `createAndFill`, which
 *     is where the `CREATE TABLE` and the parameterised `INSERT` already live.
 *
 * What is left is the teacher's own SQL, executed verbatim on a connection
 * opened *as the student*. Nothing is interpolated into it — it is the string
 * the teacher typed, run with the privileges of the person it is being run for.
 *
 * ## Why a CSV source is stored as CSV
 *
 * The obvious alternative is to generate `CREATE TABLE` + `INSERT` text when the
 * teacher uploads, store that, and replay it. It was rejected because generating
 * `INSERT INTO kunden VALUES ('Müller', …)` means building *data* by string
 * concatenation from a file nobody has validated — precisely what `import.ts`'s
 * header refuses to do. Keeping the CSV means the values reach Postgres as `$n`
 * parameters on every replay, and it means the teacher can still see the file
 * they uploaded rather than a wall of generated SQL.
 *
 * ## Materialisation is lazy
 *
 * A workspace is built when the student first opens the exercise, not for all 25
 * of them when the teacher presses "distribute". Three reasons, in order of how
 * much they cost to get wrong: a student enrolled in week six gets one too; a
 * failure is one student's, visible to them, and retried by clicking again
 * rather than leaving a fan-out half done with nothing watching it; and a
 * workspace lost to "wipe my whole database" comes back by itself, because the
 * absence of the schema *is* the trigger.
 */

import type pg from 'pg';
import { allocateIdentifier, workspaceSchemaBase } from '../auth/identifiers.js';
import type { Db, Queryable } from '../db/query.js';
import { audit } from './audit.js';
import { type ColumnType, coerce, parseCsv, usesDecimalComma } from './csv.js';
import { createAndFill, foldRelationName, MAX_IMPORT_COLUMNS } from './import.js';
import type { Provisioner } from './provision.js';
import { type QueryError, toQueryError } from './query.js';
import { estimateImportBytes, type QuotaGuard } from './quota.js';
import { pgIdentity, ServiceError } from './users.js';

// --- limits ------------------------------------------------------------------
//
// Far below the student-facing import's 10 MB / 100 000 rows, and deliberately:
// a fixture is copied into *every* student in the class and counts against each
// of their quotas, so a 10 MB exercise handed to 25 students is 250 MB and eats
// half of a 50 MB allowance per student in one go. These are lesson fixtures.

export const MAX_TITLE_LENGTH = 200;
export const MAX_TASK_LENGTH = 20_000;
export const MAX_SOURCE_SQL_LENGTH = 100_000;
export const MAX_SOURCE_CSV_LENGTH = 2 * 1024 * 1024;
export const MAX_SOURCE_CSV_ROWS = 20_000;
export const MAX_SOURCES = 20;

export const SOURCE_KINDS = ['sql', 'csv'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// --- shapes ------------------------------------------------------------------

export interface ExerciseSourceSummary {
  id: number;
  position: number;
  kind: SourceKind;
  label: string;
  /** Rows a CSV source will insert. Null for a script, which we do not parse. */
  rowCount: number | null;
  /** Columns of a CSV source, for the teacher's collapsed row. */
  columns: { name: string; type: ColumnType }[] | null;
  /** Present only when the teacher asked for one source in full. */
  sqlText?: string;
  csvText?: string;
}

export interface ExerciseAssignment {
  classId: number;
  code: string;
  name: string;
  assignedAt: string;
  /** How many students in that class have opened it. Teacher-facing only. */
  openedBy: number;
  submissions: number;
}

export interface Exercise {
  id: number;
  teacherId: number;
  teacherName: string;
  title: string;
  taskMd: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExerciseDetail extends Exercise {
  sources: ExerciseSourceSummary[];
  assignments: ExerciseAssignment[];
}

/** One exercise as the student's list shows it. */
export interface StudentExercise {
  id: number;
  title: string;
  taskMd: string;
  teacherName: string;
  assignedAt: string;
  /** The schema, once they have opened it. Null until then. */
  schema: string | null;
  submissions: number;
  lastSubmittedAt: string | null;
}

export interface Submission {
  id: number;
  exerciseId: number;
  userId: number;
  displayName: string;
  username: string;
  attempt: number;
  sqlText: string;
  note: string | null;
  createdAt: string;
}

/**
 * The result of opening or resetting a workspace.
 *
 * Shaped like `ProvisionOutcome` and for the same reason: the meta row is
 * committed before anything touches the teaching database, so a failure here
 * cannot honestly turn the request into an error — the exercise *is* assigned,
 * the name *is* allocated, and clicking again is a real retry. `failedSource`
 * names the fixture that broke, which is the only thing that lets a teacher fix
 * their own script.
 */
export interface WorkspaceOutcome {
  ok: boolean;
  schema: string;
  /** True when this call built the tables, false when they were already there. */
  materialised: boolean;
  failedSource?: { id: number; label: string };
  error?: QueryError;
}

// --- rows --------------------------------------------------------------------

interface ExerciseRow {
  id: number;
  teacherId: number;
  teacherName: string;
  title: string;
  taskMd: string;
  createdAt: string;
  updatedAt: string;
}

const EXERCISE_COLUMNS = `e.id, e.teacher_id AS "teacherId", t.display_name AS "teacherName",
                          e.title, e.task_md AS "taskMd",
                          e.created_at AS "createdAt", e.updated_at AS "updatedAt"`;

interface SourceRow {
  id: number;
  position: number;
  kind: SourceKind;
  label: string;
  rowCount: number | null;
  sqlText: string | null;
  csvText: string | null;
  csvSpec: { name: string; type: ColumnType }[] | null;
}

const SOURCE_QUERY = `SELECT id, position, kind, label,
                             row_count AS "rowCount", sql_text AS "sqlText",
                             csv_text AS "csvText", csv_spec AS "csvSpec"
                        FROM exercise_source
                       WHERE exercise_id = $1
                       ORDER BY position, id`;

function summarise(row: SourceRow): ExerciseSourceSummary {
  return {
    id: row.id,
    position: row.position,
    kind: row.kind,
    label: row.label,
    rowCount: row.rowCount,
    columns: row.csvSpec,
  };
}

// --- CSV sources -------------------------------------------------------------

export interface CsvSourceInput {
  label: string;
  csv: string;
  columns: { name: string; type: ColumnType }[];
  delimiter?: string | undefined;
  hasHeader?: boolean | undefined;
}

/**
 * Parse and coerce a stored CSV source into the rows an `INSERT` will carry.
 *
 * Run twice over a source's life: once when the teacher adds it, so a file whose
 * types do not hold is refused *then* rather than in front of a class, and once
 * per student at materialisation. The second run is not trusting the first — the
 * spec is stored, so both runs see identical input and any drift is a bug worth
 * failing on.
 */
interface CoercedCsv {
  table: string;
  columns: { name: string; type: ColumnType }[];
  values: (string | null)[][];
}

/** A source ready to replay: the row, plus its parsed rows if it is a CSV. */
interface PreparedSource {
  row: SourceRow;
  csv?: CoercedCsv;
}

function coerceSource(row: SourceRow): CoercedCsv {
  const spec = row.csvSpec ?? [];
  const parsed = parseCsv(row.csvText ?? '', {
    maxRows: MAX_SOURCE_CSV_ROWS,
    maxColumns: MAX_IMPORT_COLUMNS,
  });
  const decimalComma = usesDecimalComma(parsed.delimiter);

  const values: (string | null)[][] = [];
  for (const cells of parsed.rows) {
    const out: (string | null)[] = [];
    for (const [c, column] of spec.entries()) {
      // `undefined` means the type rejected the cell. It cannot happen for a
      // source that was accepted by `addCsvSource`, which coerces the whole file
      // before storing it — so reaching here is a bug, and `null` would hide it
      // as a mysteriously empty column in twenty-five students' tables.
      const value = coerce(cells[c] ?? '', column.type, decimalComma);
      if (value === undefined) {
        throw new Error(
          `stored CSV source ${row.id} no longer coerces: column "${column.name}" ` +
            `rejected ${JSON.stringify((cells[c] ?? '').slice(0, 60))}`,
        );
      }
      out.push(value);
    }
    values.push(out);
  }

  return { table: foldRelationName(row.label), columns: spec, values };
}

// --- the service -------------------------------------------------------------

export interface ExerciseServiceDeps {
  /** The meta database. Everything in this file's own tables lives here. */
  db: Db;
  /** For the schema, its drop, and the teacher's read grant on it. */
  prov: Provisioner;
  /** A fixture counts against the student it is copied into. */
  quota: QuotaGuard;
  /** The same per-student pool the runner, the catalog and the importer use. */
  getPool: (pgRole: string, pgPassword: string) => pg.Pool;
}

export function makeExerciseService(deps: ExerciseServiceDeps) {
  const { db, prov, quota, getPool } = deps;

  // --- reading -------------------------------------------------------------

  async function getExercise(q: Queryable, id: number): Promise<Exercise | undefined> {
    const { rows } = await q.query<ExerciseRow>(
      `SELECT ${EXERCISE_COLUMNS}
         FROM exercise e JOIN app_user t ON t.id = e.teacher_id
        WHERE e.id = $1`,
      [id],
    );
    return rows[0];
  }

  /** Every exercise a teacher owns; every exercise in the instance for an admin. */
  async function listExercises(teacherId: number | null): Promise<Exercise[]> {
    const { rows } = await db.query<ExerciseRow>(
      `SELECT ${EXERCISE_COLUMNS}
         FROM exercise e JOIN app_user t ON t.id = e.teacher_id
        WHERE $1::bigint IS NULL OR e.teacher_id = $1
        ORDER BY e.updated_at DESC`,
      [teacherId],
    );
    return rows;
  }

  async function detail(id: number): Promise<ExerciseDetail | undefined> {
    const exercise = await getExercise(db, id);
    if (!exercise) return undefined;

    const { rows: sources } = await db.query<SourceRow>(SOURCE_QUERY, [id]);
    // Two counts per class in one pass rather than per row: this renders a list,
    // and a query per class is how a teacher with eight classes waits.
    const { rows: assignments } = await db.query<ExerciseAssignment>(
      `SELECT c.id AS "classId", c.code, c.name,
              a.assigned_at AS "assignedAt",
              (SELECT count(*)::int FROM exercise_workspace w
                 JOIN class_member cm ON cm.user_id = w.user_id AND cm.class_id = c.id
                WHERE w.exercise_id = a.exercise_id) AS "openedBy",
              (SELECT count(*)::int FROM submission s
                 JOIN class_member cm ON cm.user_id = s.user_id AND cm.class_id = c.id
                WHERE s.exercise_id = a.exercise_id) AS "submissions"
         FROM exercise_assignment a JOIN class c ON c.id = a.class_id
        WHERE a.exercise_id = $1
        ORDER BY c.code`,
      [id],
    );

    return { ...exercise, sources: sources.map(summarise), assignments };
  }

  /** One source in full, for the teacher's editor. */
  async function getSource(exerciseId: number, sourceId: number): Promise<ExerciseSourceSummary> {
    const { rows } = await db.query<SourceRow>(
      `${SOURCE_QUERY.replace('WHERE exercise_id = $1', 'WHERE exercise_id = $1 AND id = $2')}`,
      [exerciseId, sourceId],
    );
    const row = rows[0];
    if (!row) throw new ServiceError('source_not_found', 'No such table in this exercise.');
    return {
      ...summarise(row),
      ...(row.sqlText === null ? {} : { sqlText: row.sqlText }),
      ...(row.csvText === null ? {} : { csvText: row.csvText }),
    };
  }

  // --- writing (teacher) ---------------------------------------------------

  async function createExercise(
    actorId: number,
    input: { title: string; taskMd: string },
  ): Promise<Exercise> {
    return db.tx(async (q) => {
      const { rows } = await q.query<{ id: number }>(
        `INSERT INTO exercise (teacher_id, title, task_md) VALUES ($1, $2, $3) RETURNING id`,
        [actorId, input.title, input.taskMd],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('INSERT … RETURNING id produced no row');
      await audit(q, {
        actorId,
        action: 'exercise_created',
        targetType: 'exercise',
        targetId: id,
        detail: { title: input.title },
      });
      const created = await getExercise(q, id);
      if (!created) throw new Error('exercise disappeared inside its own transaction');
      return created;
    });
  }

  async function updateExercise(
    actorId: number,
    id: number,
    patch: { title?: string; taskMd?: string },
  ): Promise<Exercise> {
    return db.tx(async (q) => {
      const { rows } = await q.query<{ id: number }>(
        `UPDATE exercise
            SET title   = coalesce($2, title),
                task_md = coalesce($3, task_md),
                updated_at = now()
          WHERE id = $1
        RETURNING id`,
        [id, patch.title ?? null, patch.taskMd ?? null],
      );
      if (rows.length === 0) throw new ServiceError('exercise_not_found', 'No such exercise.');
      await audit(q, {
        actorId,
        action: 'exercise_updated',
        targetType: 'exercise',
        targetId: id,
        detail: { fields: Object.keys(patch) },
      });
      const updated = await getExercise(q, id);
      if (!updated) throw new Error('exercise disappeared inside its own transaction');
      return updated;
    });
  }

  /** Bump `updated_at` when a source changes — the list sorts by it. */
  async function touch(q: Queryable, id: number): Promise<void> {
    await q.query(`UPDATE exercise SET updated_at = now() WHERE id = $1`, [id]);
  }

  async function assertRoom(q: Queryable, exerciseId: number): Promise<void> {
    const { rows } = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM exercise_source WHERE exercise_id = $1`,
      [exerciseId],
    );
    if ((rows[0]?.n ?? 0) >= MAX_SOURCES) {
      throw new ServiceError(
        'too_many_sources',
        `An exercise may hold at most ${MAX_SOURCES} tables or scripts.`,
      );
    }
  }

  async function nextPosition(q: Queryable, exerciseId: number): Promise<number> {
    const { rows } = await q.query<{ next: number }>(
      `SELECT coalesce(max(position), -1) + 1 AS next FROM exercise_source WHERE exercise_id = $1`,
      [exerciseId],
    );
    return rows[0]?.next ?? 0;
  }

  async function addSqlSource(
    actorId: number,
    exerciseId: number,
    input: { label: string; sqlText: string },
  ): Promise<ExerciseSourceSummary> {
    return db.tx(async (q) => {
      await assertRoom(q, exerciseId);
      const { rows } = await q.query<SourceRow>(
        `INSERT INTO exercise_source (exercise_id, position, kind, label, sql_text)
         VALUES ($1, $2, 'sql', $3, $4)
         RETURNING id, position, kind, label, row_count AS "rowCount",
                   sql_text AS "sqlText", csv_text AS "csvText", csv_spec AS "csvSpec"`,
        [exerciseId, await nextPosition(q, exerciseId), input.label, input.sqlText],
      );
      const row = rows[0];
      if (!row) throw new Error('INSERT … RETURNING produced no row');
      await touch(q, exerciseId);
      return summarise(row);
    });
  }

  /**
   * Add a CSV fixture — and coerce the whole file first.
   *
   * The refusal has to happen here. A file whose types do not hold and is stored
   * anyway fails at *materialisation*, which is a student clicking on an
   * exercise during a lesson and being told their teacher's fixture is broken.
   * Coercing now costs one pass over at most 2 MB and moves that failure to the
   * person who can fix it, while they are looking at it.
   */
  async function addCsvSource(
    actorId: number,
    exerciseId: number,
    input: CsvSourceInput,
  ): Promise<ExerciseSourceSummary> {
    const table = foldRelationName(input.label);
    if (table === '') {
      throw new ServiceError(
        'invalid_table_name',
        'The table name must contain at least one letter or digit.',
      );
    }

    const parsed = parseCsv(input.csv, {
      ...(input.delimiter === undefined ? {} : { delimiter: input.delimiter }),
      ...(input.hasHeader === undefined ? {} : { hasHeader: input.hasHeader }),
      maxRows: MAX_SOURCE_CSV_ROWS,
      maxColumns: MAX_IMPORT_COLUMNS,
    });
    if (parsed.header.length === 0) throw new ServiceError('empty_csv', 'The file holds no rows.');
    if (parsed.totalRows > MAX_SOURCE_CSV_ROWS) {
      throw new ServiceError(
        'csv_too_many_rows',
        `The file holds ${parsed.totalRows} rows; an exercise fixture may hold at most ` +
          `${MAX_SOURCE_CSV_ROWS}, because every student in the class gets a copy.`,
      );
    }
    if (input.columns.length !== parsed.header.length) {
      throw new ServiceError(
        'column_count_mismatch',
        `The file has ${parsed.header.length} columns but ${input.columns.length} were described.`,
      );
    }

    const columns = input.columns.map((column, i) => ({
      name: foldRelationName(column.name) || `spalte${i + 1}`,
      type: column.type,
    }));
    if (new Set(columns.map((c) => c.name)).size !== columns.length) {
      throw new ServiceError('duplicate_column_name', 'Two columns fold to the same name.');
    }

    // The whole file, before anything is stored. See the header above.
    const decimalComma = usesDecimalComma(parsed.delimiter);
    const errors: { line: number; column: string; value: string; expected: ColumnType }[] = [];
    for (const [r, cells] of parsed.rows.entries()) {
      for (const [c, column] of columns.entries()) {
        const raw = cells[c] ?? '';
        if (coerce(raw, column.type, decimalComma) === undefined && errors.length < 20) {
          errors.push({
            line: parsed.lines[r] ?? r + 1,
            column: column.name,
            value: raw.slice(0, 100),
            expected: column.type,
          });
        }
      }
    }
    if (errors.length > 0) {
      // Thrown rather than returned `{ ok: false }`, unlike the student's import.
      // There the per-cell report *is* the lesson — a column that is not really a
      // number is what the exercise is teaching. Here it is a teacher preparing
      // material, and there is nothing to learn from it except which cells to fix.
      throw new ServiceError(
        'csv_types_rejected',
        `${errors.length} cell(s) do not match the chosen types, first at line ` +
          `${String(errors[0]?.line)} in "${String(errors[0]?.column)}".`,
      );
    }

    return db.tx(async (q) => {
      await assertRoom(q, exerciseId);
      const { rows } = await q.query<SourceRow>(
        `INSERT INTO exercise_source
           (exercise_id, position, kind, label, csv_text, csv_spec, row_count)
         VALUES ($1, $2, 'csv', $3, $4, $5::jsonb, $6)
         RETURNING id, position, kind, label, row_count AS "rowCount",
                   sql_text AS "sqlText", csv_text AS "csvText", csv_spec AS "csvSpec"`,
        [
          exerciseId,
          await nextPosition(q, exerciseId),
          table,
          input.csv,
          JSON.stringify(columns),
          parsed.rows.length,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('INSERT … RETURNING produced no row');
      await touch(q, exerciseId);
      return summarise(row);
    });
  }

  async function removeSource(exerciseId: number, sourceId: number): Promise<void> {
    const result = await db.query(`DELETE FROM exercise_source WHERE id = $1 AND exercise_id = $2`, [
      sourceId,
      exerciseId,
    ]);
    if (result.rowCount === 0) {
      throw new ServiceError('source_not_found', 'No such table in this exercise.');
    }
    await touch(db, exerciseId);
  }

  /** Reorder in one statement: `ids` in the order they should replay. */
  async function reorderSources(exerciseId: number, ids: number[]): Promise<void> {
    await db.tx(async (q) => {
      await q.query(
        `UPDATE exercise_source s
            SET position = o.ord
           FROM unnest($2::bigint[]) WITH ORDINALITY AS o(id, ord)
          WHERE s.id = o.id AND s.exercise_id = $1`,
        [exerciseId, ids],
      );
      await touch(q, exerciseId);
    });
  }

  // --- distribution --------------------------------------------------------

  async function distribute(actorId: number, exerciseId: number, classId: number): Promise<void> {
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO exercise_assignment (exercise_id, class_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [exerciseId, classId],
      );
      await audit(q, {
        actorId,
        action: 'exercise_distributed',
        targetType: 'exercise',
        targetId: exerciseId,
        detail: { classId },
      });
    });
  }

  /**
   * Take an exercise back from a class: the assignment, every student's tables,
   * and their hand-ins.
   *
   * Irreversible and it says so — the route puts it behind two dialogs, the same
   * weight `roster.js` gives deleting a student, because this is the same kind of
   * thing: a term's work in one click, for a whole class at once.
   *
   * **Order matters and it is dropped-first.** The schemas go before the meta
   * rows, because `exercise_workspace` is what says which schemas exist to drop;
   * delete the rows first and a failure half way through leaves schemas nothing
   * knows about, on disk, counting against students' quotas, with no UI that can
   * reach them. The reverse — schemas gone, rows still there — is repaired by the
   * next `openWorkspace`, which finds no schema and rebuilds. One direction
   * self-heals and the other leaks.
   */
  async function takeBack(
    actorId: number,
    exerciseId: number,
    classId: number,
  ): Promise<{ workspaces: number; submissions: number; failures: string[] }> {
    const { rows: targets } = await db.query<{ userId: number; pgRole: string; schema: string }>(
      `SELECT w.user_id AS "userId", u.pg_role AS "pgRole", w.schema_name AS schema
         FROM exercise_workspace w
         JOIN class_member cm ON cm.user_id = w.user_id AND cm.class_id = $2
         JOIN app_user u ON u.id = w.user_id
        WHERE w.exercise_id = $1 AND u.pg_role IS NOT NULL`,
      [exerciseId, classId],
    );

    const failures: string[] = [];
    const dropped: number[] = [];
    for (const target of targets) {
      try {
        await prov.dropWorkspace(target.pgRole, target.schema);
        dropped.push(target.userId);
      } catch (err) {
        // Not fatal to the rest. One student's schema refusing to drop must not
        // leave the other twenty-four assigned to an exercise the teacher has
        // taken back; the failure is reported, audited, and the meta row is
        // *kept* so the next take-back retries exactly this one.
        failures.push(`${target.schema}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const counts = await db.tx(async (q) => {
      const submissions = await q.query(
        `DELETE FROM submission s
          USING class_member cm
          WHERE s.exercise_id = $1 AND cm.user_id = s.user_id AND cm.class_id = $2`,
        [exerciseId, classId],
      );
      if (dropped.length > 0) {
        await q.query(
          `DELETE FROM exercise_workspace WHERE exercise_id = $1 AND user_id = ANY($2::bigint[])`,
          [exerciseId, dropped],
        );
      }
      await q.query(`DELETE FROM exercise_assignment WHERE exercise_id = $1 AND class_id = $2`, [
        exerciseId,
        classId,
      ]);
      await audit(q, {
        actorId,
        action: 'exercise_taken_back',
        targetType: 'exercise',
        targetId: exerciseId,
        detail: {
          classId,
          workspaces: dropped.length,
          submissions: submissions.rowCount ?? 0,
          failures,
        },
      });
      return { submissions: submissions.rowCount ?? 0 };
    });

    return { workspaces: dropped.length, submissions: counts.submissions, failures };
  }

  /** Delete the exercise itself. Takes every class's copy with it. */
  async function deleteExercise(actorId: number, exerciseId: number): Promise<void> {
    const { rows: targets } = await db.query<{ pgRole: string; schema: string }>(
      `SELECT u.pg_role AS "pgRole", w.schema_name AS schema
         FROM exercise_workspace w JOIN app_user u ON u.id = w.user_id
        WHERE w.exercise_id = $1 AND u.pg_role IS NOT NULL`,
      [exerciseId],
    );
    for (const target of targets) {
      // Every failure is fatal here, unlike `takeBack`. There the meta row
      // survives and the next attempt retries; here the row is about to be
      // CASCADEd away, so a schema that did not drop would become unreachable —
      // owned by a student, counted against their quota, and named by nothing.
      await prov.dropWorkspace(target.pgRole, target.schema);
    }

    await db.tx(async (q) => {
      const result = await q.query(`DELETE FROM exercise WHERE id = $1`, [exerciseId]);
      if (result.rowCount === 0) throw new ServiceError('exercise_not_found', 'No such exercise.');
      await audit(q, {
        actorId,
        action: 'exercise_deleted',
        targetType: 'exercise',
        targetId: exerciseId,
        detail: { workspaces: targets.length },
      });
    });
  }

  // --- the student's side --------------------------------------------------

  /** Exercises assigned to any class this student sits in. */
  async function listForStudent(userId: number): Promise<StudentExercise[]> {
    const { rows } = await db.query<StudentExercise>(
      `SELECT e.id, e.title, e.task_md AS "taskMd",
              t.display_name AS "teacherName",
              min(a.assigned_at) AS "assignedAt",
              w.schema_name AS schema,
              (SELECT count(*)::int FROM submission s
                WHERE s.exercise_id = e.id AND s.user_id = $1) AS submissions,
              (SELECT max(s.created_at) FROM submission s
                WHERE s.exercise_id = e.id AND s.user_id = $1) AS "lastSubmittedAt"
         FROM exercise_assignment a
         JOIN class_member cm ON cm.class_id = a.class_id AND cm.user_id = $1
         JOIN exercise e ON e.id = a.exercise_id
         JOIN app_user t ON t.id = e.teacher_id
         LEFT JOIN exercise_workspace w ON w.exercise_id = e.id AND w.user_id = $1
        GROUP BY e.id, e.title, e.task_md, t.display_name, w.schema_name
        ORDER BY min(a.assigned_at) DESC, e.id DESC`,
      [userId],
    );
    return rows;
  }

  /**
   * May this account work on this exercise?
   *
   * Two ways in, and the second is not a convenience. A teacher owns the
   * exercise but is in none of its classes, so without it they could build a
   * fixture and never run it — and "test it on a student" is the one way of
   * finding out that costs a student their afternoon. Their workspace is their
   * own schema like anyone else's, so this grants no reach into anybody's data.
   */
  async function mayOpen(userId: number, exerciseId: number): Promise<boolean> {
    const { rows } = await db.query<{ ok: boolean }>(
      `SELECT true AS ok FROM exercise e
        WHERE e.id = $2
          AND (e.teacher_id = $1
               OR EXISTS (SELECT 1 FROM exercise_assignment a
                            JOIN class_member cm ON cm.class_id = a.class_id
                           WHERE a.exercise_id = e.id AND cm.user_id = $1))
        LIMIT 1`,
      [userId, exerciseId],
    );
    return rows.length > 0;
  }

  /**
   * Reserve this student's schema name for this exercise, or return the one
   * already reserved.
   *
   * `ON CONFLICT DO NOTHING` then re-select, rather than `RETURNING`: two tabs
   * opening the same exercise at the same instant must end up with one name, and
   * the second insert has to lose quietly rather than answer nothing.
   */
  async function reserveSchema(userId: number, exerciseId: number, pgRole: string): Promise<string> {
    const existing = await db.query<{ schema: string }>(
      `SELECT schema_name AS schema FROM exercise_workspace WHERE exercise_id = $1 AND user_id = $2`,
      [exerciseId, userId],
    );
    const found = existing.rows[0]?.schema;
    if (found !== undefined) return found;

    // `_` is a LIKE wildcard and every base is full of them, so this matches a
    // superset of the names that could actually collide. That is the safe
    // direction: an extra candidate is skipped, a missed one would be handed out
    // twice. Scoped by the `x<id>_` prefix, so it never sees another exercise.
    const { rows: taken } = await db.query<{ schema: string }>(
      `SELECT schema_name AS schema FROM exercise_workspace WHERE schema_name LIKE $1`,
      [`${workspaceSchemaBase(exerciseId, pgRole)}%`],
    );
    const name = allocateIdentifier(
      workspaceSchemaBase(exerciseId, pgRole),
      new Set(taken.map((r) => r.schema)),
    );

    await db.query(
      `INSERT INTO exercise_workspace (exercise_id, user_id, schema_name)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [exerciseId, userId, name],
    );
    const settled = await db.query<{ schema: string }>(
      `SELECT schema_name AS schema FROM exercise_workspace WHERE exercise_id = $1 AND user_id = $2`,
      [exerciseId, userId],
    );
    const schema = settled.rows[0]?.schema;
    if (schema === undefined) throw new Error('workspace row vanished after insert');
    return schema;
  }

  /**
   * Replay the exercise's sources into a freshly made workspace.
   *
   * One transaction for all of them, so a fixture of four tables lands whole:
   * a student staring at two of four tables and a red error is in a state where
   * "reset" and "open" both look like they might help and neither is obviously
   * right, whereas an empty workspace has exactly one next step.
   *
   * `search_path` is the workspace alone — **not** `"$user"` — so an unqualified
   * `CREATE TABLE` in a teacher's script lands in the exercise rather than in the
   * student's own playground. It is reset in the `finally` for the reason
   * `provision.ts`'s `asRole` gives: node-postgres does not `DISCARD ALL` on
   * release, so a leaked `SET` is handed to whatever uses this connection next.
   */
  async function materialise(
    client: pg.PoolClient,
    schema: string,
    sources: readonly PreparedSource[],
  ): Promise<{ id: number; label: string; error: QueryError } | null> {
    let current: PreparedSource | undefined;
    try {
      await client.query('BEGIN');
      // A bind parameter cannot be a `SET` target, but `set_config` takes one —
      // which is how this file keeps its promise to build no SQL by string.
      await client.query(`SELECT set_config('search_path', $1, false)`, [schema]);

      for (const source of sources) {
        current = source;
        if (source.csv) {
          await createAndFill(client, { schema, ...source.csv, replace: false });
        } else {
          // Verbatim, with no parameters, so node-postgres uses the simple query
          // protocol and a script of several statements runs as one — which is
          // what a teacher pasting a schema dump expects.
          await client.query(source.row.sqlText ?? '');
        }
      }

      await client.query('COMMIT');
      return null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return {
        id: current?.row.id ?? 0,
        label: current?.row.label ?? '',
        error: toQueryError(err),
      };
    } finally {
      await client.query('RESET search_path').catch(() => {});
    }
  }

  async function openWorkspace(userId: number, exerciseId: number): Promise<WorkspaceOutcome> {
    if (!(await mayOpen(userId, exerciseId))) {
      throw new ServiceError('exercise_not_found', 'No such exercise.');
    }
    const identity = await pgIdentity(db, userId);
    if (!identity) {
      throw new ServiceError('not_provisioned', 'This account has no database of its own.');
    }
    if (identity.state !== 'active') {
      throw new ServiceError('user_not_active', 'This account is not active.');
    }

    const schema = await reserveSchema(userId, exerciseId, identity.pgRole);
    const { created } = await prov.createWorkspace(
      identity.pgRole,
      schema,
      identity.teacherRoles,
    );
    if (!created) return { ok: true, schema, materialised: false };

    const { rows } = await db.query<SourceRow>(SOURCE_QUERY, [exerciseId]);
    if (rows.length === 0) return { ok: true, schema, materialised: true };

    // Coerced once, here, and carried into `materialise`. Doing it inside the
    // loop would parse every CSV twice — once to size it for the quota and again
    // to insert it — which on a 2 MB fixture is real work done for nothing.
    const sources: PreparedSource[] = rows.map((row) => ({
      row,
      ...(row.kind === 'csv' ? { csv: coerceSource(row) } : {}),
    }));

    // Before a connection is taken, so being out of space cannot look like
    // `too_many_queries` — the same ordering, and the same reason, as
    // `services/query.ts`. The estimate covers the CSV fixtures only; a script's
    // output is unknowable until it has run, which is the limit the quota has
    // always had (HANDOFF §3).
    const estimate = sources.reduce(
      (sum, s) => sum + (s.csv ? estimateImportBytes(s.csv.values) : 0),
      0,
    );
    await quota.check(identity.pgRole, estimate);

    const pool = getPool(identity.pgRole, identity.pgPassword);
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new ServiceError(
        'too_many_queries',
        'No database connection was free. Usually one of your own queries is still ' +
          'running; if not, the server is refusing connections.',
      );
    }

    try {
      const failure = await materialise(client, schema, sources);
      if (!failure) return { ok: true, schema, materialised: true };
      return {
        ok: false,
        schema,
        materialised: false,
        failedSource: { id: failure.id, label: failure.label },
        error: failure.error,
      };
    } finally {
      client.release();
    }
  }

  /**
   * "Reset the tables of this exercise", and nothing else.
   *
   * The narrow counterpart to `/api/workspace/reset`, which drops everything the
   * student owns. Here the drop is one `DROP SCHEMA`, so the playground and every
   * *other* exercise are untouched by construction rather than by a filter.
   */
  async function resetWorkspace(userId: number, exerciseId: number): Promise<WorkspaceOutcome> {
    if (!(await mayOpen(userId, exerciseId))) {
      throw new ServiceError('exercise_not_found', 'No such exercise.');
    }
    const identity = await pgIdentity(db, userId);
    if (!identity) {
      throw new ServiceError('not_provisioned', 'This account has no database of its own.');
    }
    const { rows } = await db.query<{ schema: string }>(
      `SELECT schema_name AS schema FROM exercise_workspace WHERE exercise_id = $1 AND user_id = $2`,
      [exerciseId, userId],
    );
    const schema = rows[0]?.schema;
    if (schema !== undefined) await prov.dropWorkspace(identity.pgRole, schema);

    await audit(db, {
      actorId: userId,
      action: 'exercise_workspace_reset',
      targetType: 'exercise',
      targetId: exerciseId,
      detail: { userId, schema: schema ?? null },
    });

    // The row is kept, so the same name comes back — `openWorkspace` finds no
    // schema and rebuilds into it.
    return openWorkspace(userId, exerciseId);
  }

  /**
   * Every workspace this account holds, with the exercise it belongs to.
   *
   * Not `listForStudent`, which is driven by *assignments* — a teacher who built
   * their own copy to test a fixture is in none of its classes, so that query
   * cannot see their schema and the browser would show them a bare
   * `x7_t_lehrer`. This one is driven by `exercise_workspace`, which is exactly
   * "schemas that are mine".
   */
  async function workspacesFor(userId: number): Promise<{ schema: string; title: string }[]> {
    const { rows } = await db.query<{ schema: string; title: string }>(
      `SELECT w.schema_name AS schema, e.title
         FROM exercise_workspace w JOIN exercise e ON e.id = w.exercise_id
        WHERE w.user_id = $1
        ORDER BY e.title`,
      [userId],
    );
    return rows;
  }

  /**
   * Workspace schemas for a set of students, for the lesson view's disk column.
   *
   * Returned per user rather than as one list, because the caller has to
   * *attribute* the bytes: a student's exercise schemas are their disk, and the
   * teacher's roster shows one number per student.
   */
  async function workspacesByUser(userIds: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    if (userIds.length === 0) return out;
    const { rows } = await db.query<{ userId: number; schema: string }>(
      `SELECT user_id AS "userId", schema_name AS schema
         FROM exercise_workspace WHERE user_id = ANY($1::bigint[])`,
      [userIds],
    );
    for (const row of rows) {
      const held = out.get(row.userId) ?? [];
      held.push(row.schema);
      out.set(row.userId, held);
    }
    return out;
  }

  /**
   * The schema a query should run against, for `routes/query.ts`.
   *
   * Resolved here from `exercise_workspace` and never from the request body:
   * the browser sends an exercise id, and which schema that means for this
   * caller is a question only the server may answer. Sending the schema name
   * instead would make "run my SQL in schema X" a thing the client can ask for,
   * which is the one shape this app must not have — even though Postgres would
   * still refuse the interesting cases.
   *
   * Does **not** create anything. A student who has not opened the exercise gets
   * `exercise_not_open`, which the page turns into opening it; provisioning
   * silently from the run button would put a schema-creating side effect behind
   * every keystroke of Ctrl+Enter.
   */
  async function workspaceFor(userId: number, exerciseId: number) {
    if (!(await mayOpen(userId, exerciseId))) {
      throw new ServiceError('exercise_not_found', 'No such exercise.');
    }
    const { rows } = await db.query<{ schema: string }>(
      `SELECT schema_name AS schema FROM exercise_workspace WHERE exercise_id = $1 AND user_id = $2`,
      [exerciseId, userId],
    );
    const schema = rows[0]?.schema;
    if (schema === undefined) {
      throw new ServiceError('exercise_not_open', 'Open this exercise before running SQL in it.');
    }
    return { exerciseId, schema };
  }

  // --- hand-ins ------------------------------------------------------------

  async function submit(
    userId: number,
    exerciseId: number,
    input: { sqlText: string; note?: string | undefined },
  ): Promise<Submission> {
    if (!(await mayOpen(userId, exerciseId))) {
      throw new ServiceError('exercise_not_found', 'No such exercise.');
    }
    return db.tx(async (q) => {
      // `max + 1` inside the transaction, and `submission_attempt_key` is what
      // makes it safe: two simultaneous submits both read the same max, and the
      // loser gets a unique violation rather than a second "Abgabe 3".
      const { rows } = await q.query<Submission>(
        `INSERT INTO submission (exercise_id, user_id, sql_text, note, attempt)
         SELECT $1, $2, $3, $4,
                coalesce((SELECT max(attempt) FROM submission
                           WHERE exercise_id = $1 AND user_id = $2), 0) + 1
         RETURNING id, exercise_id AS "exerciseId", user_id AS "userId",
                   attempt, sql_text AS "sqlText", note, created_at AS "createdAt"`,
        [exerciseId, userId, input.sqlText, input.note ?? null],
      );
      const row = rows[0];
      if (!row) throw new Error('INSERT … RETURNING produced no row');
      const { rows: who } = await q.query<{ displayName: string; username: string }>(
        `SELECT display_name AS "displayName", username FROM app_user WHERE id = $1`,
        [userId],
      );
      return { ...row, displayName: who[0]?.displayName ?? '', username: who[0]?.username ?? '' };
    });
  }

  /**
   * Hand-ins for one exercise. `classId` narrows to one class; `userId` to one
   * student. The student's own list passes their own id and gets the same shape.
   */
  async function listSubmissions(
    exerciseId: number,
    filter: { classId?: number | undefined; userId?: number | undefined } = {},
  ): Promise<Submission[]> {
    const { rows } = await db.query<Submission>(
      `SELECT s.id, s.exercise_id AS "exerciseId", s.user_id AS "userId",
              u.display_name AS "displayName", u.username,
              s.attempt, s.sql_text AS "sqlText", s.note, s.created_at AS "createdAt"
         FROM submission s
         JOIN app_user u ON u.id = s.user_id
        WHERE s.exercise_id = $1
          AND ($2::bigint IS NULL OR s.user_id = $2)
          AND ($3::bigint IS NULL OR EXISTS (
                SELECT 1 FROM class_member cm
                 WHERE cm.user_id = s.user_id AND cm.class_id = $3))
        ORDER BY u.display_name, s.attempt`,
      [exerciseId, filter.userId ?? null, filter.classId ?? null],
    );
    return rows;
  }

  async function getSubmission(id: number): Promise<Submission | undefined> {
    const { rows } = await db.query<Submission>(
      `SELECT s.id, s.exercise_id AS "exerciseId", s.user_id AS "userId",
              u.display_name AS "displayName", u.username,
              s.attempt, s.sql_text AS "sqlText", s.note, s.created_at AS "createdAt"
         FROM submission s JOIN app_user u ON u.id = s.user_id
        WHERE s.id = $1`,
      [id],
    );
    return rows[0];
  }

  return {
    listExercises,
    detail,
    getSource,
    createExercise,
    updateExercise,
    deleteExercise,
    addSqlSource,
    addCsvSource,
    removeSource,
    reorderSources,
    distribute,
    takeBack,
    listForStudent,
    mayOpen,
    openWorkspace,
    resetWorkspace,
    workspaceFor,
    workspacesFor,
    workspacesByUser,
    submit,
    listSubmissions,
    getSubmission,
  };
}

export type ExerciseService = ReturnType<typeof makeExerciseService>;

// --- the download ------------------------------------------------------------

/**
 * One `.sql` file holding every hand-in asked for.
 *
 * A ZIP would be the obvious shape and is deliberately not built: this app has
 * four runtime dependencies and means to keep them, so a real archive would mean
 * hand-writing the format — CRC32 and all — for a file a teacher opens once,
 * reads top to bottom and greps. A single annotated script is better at the job
 * anyway, and `renderSubmission` below produces exactly one entry of it, so a
 * single download and a bulk download cannot drift apart.
 *
 * Timestamps are ISO 8601 with the `Z`. Not a `de-CH` rendering, because the
 * container runs UTC and the dev machine does not (HANDOFF §4gg), so a
 * locale-formatted time in a *file* would be the one artefact whose meaning
 * depends on where it was generated.
 */
export function renderSubmission(submission: Submission, exerciseTitle: string): string {
  const rule = '-- ' + '='.repeat(70);
  const lines = [
    rule,
    `-- ${submission.displayName} (${submission.username})`,
    `-- Übung: ${exerciseTitle}`,
    `-- Abgabe ${String(submission.attempt)} — ${new Date(submission.createdAt).toISOString()}`,
  ];
  if (submission.note) {
    lines.push('--');
    // Every line prefixed, so a note containing a newline cannot produce a line
    // of prose that Postgres would try to parse if the file is ever run.
    for (const line of submission.note.split('\n')) lines.push(`-- Notiz: ${line}`);
  }
  lines.push(rule, '', submission.sqlText.trimEnd(), '');
  return lines.join('\n');
}

export function renderBundle(
  submissions: readonly Submission[],
  header: { exerciseTitle: string; className?: string | undefined },
): string {
  const students = new Set(submissions.map((s) => s.userId)).size;
  const intro = [
    '-- Datebänkli — Abgaben',
    `-- Übung: ${header.exerciseTitle}`,
    ...(header.className === undefined ? [] : [`-- Klasse: ${header.className}`]),
    `-- ${String(submissions.length)} Abgabe(n) von ${String(students)} Lernenden`,
    '',
  ].join('\n');

  return [intro, ...submissions.map((s) => renderSubmission(s, header.exerciseTitle))].join('\n');
}

/**
 * `Kundendaten` + `Muster Lena` + attempt 2 → `kundendaten-muster-lena-2.sql`.
 *
 * Through `foldRelationName` rather than a local NFD-and-strip, and the
 * difference is visible in exactly the words this school writes: a hand-rolled
 * accent strip turns `Größe` into `gro-e`, because `ß` has no decomposition to
 * strip and falls out as a separator. `auth/identifiers.ts` transliterates it —
 * `groesse` — and that is already the rule every other generated name in this
 * app follows. A filename is not a Postgres identifier, but there is no reason
 * for it to fold German differently from one, and one fewer copy of the folding
 * is one fewer place for the two to disagree.
 *
 * Hyphens rather than underscores because this is a filename, and empty rather
 * than a bare extension when everything folds away.
 */
export function downloadName(parts: readonly string[], extension = 'sql'): string {
  const slug = foldRelationName(parts.join(' ')).replace(/_/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'abgaben'}.${extension}`;
}
