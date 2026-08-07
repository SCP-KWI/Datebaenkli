/**
 * Exercises over HTTP — phase 9.
 *
 * Two audiences in one file, and the split is the authorisation story:
 *
 *   - **`/api/exercises/*`** is the teacher's: build an exercise, add tables to
 *     it, hand it to a class, take it back, read what came in. Every one of them
 *     goes through `assertOwnExercise`, which is `routes/classes.ts`'s rule in
 *     the same shape — a teacher who *guesses* an id must be refused rather than
 *     merely unable to find it in a menu.
 *   - **`/api/my/exercises/*`** is the student's, and takes no owner id at all.
 *     Everything acts on `currentUser(req)`, exactly as `routes/workspace.ts`
 *     does, so there is no path through them that names another account.
 *
 * The one route that is neither is `POST /api/exercises/:id/open`: a teacher
 * opens their *own* exercise to test the fixtures before a class sees them, and
 * gets a workspace of their own like anybody else. `mayOpen` in the service is
 * what decides, and it is the same call the student path makes.
 *
 * Nothing here is `public`. Routes are closed by default (CLAUDE.md), and every
 * one of these reads or writes somebody's work.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/query.js';
import { currentUser, requireRole } from '../http/auth.js';
import { forbidden, notFound } from '../http/errors.js';
import {
  asObject,
  bool,
  id,
  idList,
  list,
  maybe,
  oneOf,
  optionalStr,
  paramId,
  str,
} from '../http/validate.js';
import { COLUMN_TYPES, DELIMITERS } from '../services/csv.js';
import {
  downloadName,
  MAX_SOURCE_CSV_LENGTH,
  MAX_SOURCE_SQL_LENGTH,
  MAX_TASK_LENGTH,
  MAX_TITLE_LENGTH,
  renderBundle,
  renderSubmission,
  type ExerciseService,
} from '../services/exercise.js';
import { MAX_IMPORT_COLUMNS, previewCsv } from '../services/import.js';
import { assertClassAccess } from './classes.js';

const staffOnly = { preHandler: requireRole('admin', 'teacher') };
/** Students *and* teachers: a teacher tests their own exercise in their own schema. */
const anyLearner = { preHandler: requireRole('student', 'teacher') };

/**
 * Same delimiter rule as `routes/workspace.ts`: not `optionalStr`, because that
 * trims and a tab delimiter trims to nothing.
 */
const optionalDelimiter = (body: Record<string, unknown>): string | undefined =>
  body['delimiter'] === undefined || body['delimiter'] === null
    ? undefined
    : oneOf(body, 'delimiter', DELIMITERS);

const columnList = (body: Record<string, unknown>) =>
  list(
    body,
    'columns',
    (column) => ({
      name: str(column, 'name', { max: 200 }),
      type: oneOf(column, 'type', COLUMN_TYPES),
    }),
    MAX_IMPORT_COLUMNS,
  );

/**
 * A text file the browser should save rather than render.
 *
 * `attachment` with an ASCII-folded filename and no `filename*`: the names come
 * from `downloadName`, which has already folded them to `[a-z0-9-]`, so there is
 * nothing left for RFC 5987 to encode and a second parameter would only be one
 * more thing to get wrong.
 */
function sendFile(reply: FastifyReply, filename: string, body: string): FastifyReply {
  return reply
    .type('application/sql; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`)
    .send(body);
}

export function registerExerciseRoutes(
  app: FastifyInstance,
  db: Db,
  exercises: ExerciseService,
): void {
  /**
   * "Is this exercise yours to touch?" — the teacher-side gate, on every route
   * that names an id.
   *
   * An admin passes everything, which matches `assertClassAccess`. A teacher
   * passes only their own: exercises are not shared between teachers, and if
   * they ever are it should be a deliberate feature with its own table rather
   * than a widening of this line.
   */
  async function assertOwnExercise(reqUserId: number, role: string, exerciseId: number) {
    const found = await exercises.detail(exerciseId);
    if (!found) throw notFound('exercise_not_found', 'No such exercise.');
    if (role !== 'admin' && found.teacherId !== reqUserId) {
      throw forbidden('not_your_exercise', 'That exercise belongs to another teacher.');
    }
    return found;
  }

  // --- the teacher's exercises ---------------------------------------------

  app.get('/api/exercises', staffOnly, async (req) => {
    const user = currentUser(req);
    return { exercises: await exercises.listExercises(user.role === 'admin' ? null : user.id) };
  });

  app.get('/api/exercises/:id', staffOnly, async (req) => {
    const user = currentUser(req);
    return { exercise: await assertOwnExercise(user.id, user.role, paramId(req)) };
  });

  app.post('/api/exercises', staffOnly, async (req, reply) => {
    const user = currentUser(req);
    const body = asObject(req.body);
    const exercise = await exercises.createExercise(user.id, {
      title: str(body, 'title', { max: MAX_TITLE_LENGTH }),
      taskMd: optionalStr(body, 'taskMd', { max: MAX_TASK_LENGTH }) ?? '',
    });
    return reply.code(201).send({ exercise });
  });

  app.patch('/api/exercises/:id', staffOnly, async (req) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    const body = asObject(req.body);
    return {
      exercise: await exercises.updateExercise(user.id, exerciseId, {
        ...maybe('title', optionalStr(body, 'title', { max: MAX_TITLE_LENGTH })),
        // Not `optionalStr`: an empty task is a legitimate thing to save back
        // while writing one, and `optionalStr` turns '' into "leave it alone".
        ...maybe(
          'taskMd',
          typeof body['taskMd'] === 'string' ? body['taskMd'].slice(0, MAX_TASK_LENGTH) : undefined,
        ),
      }),
    };
  });

  /**
   * Deleting an exercise drops every student's copy of it, in every class.
   * Behind two dialogs on the page for the same reason `roster.js` puts deleting
   * a student behind two: the second one is the only thing between a mis-click
   * and a term's work.
   */
  app.delete('/api/exercises/:id', staffOnly, async (req) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    await exercises.deleteExercise(user.id, exerciseId);
    return { ok: true };
  });

  // --- its tables ----------------------------------------------------------

  app.get('/api/exercises/:id/sources/:sourceId', staffOnly, async (req) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    return { source: await exercises.getSource(exerciseId, paramId(req, 'sourceId')) };
  });

  app.post('/api/exercises/:id/sources/sql', staffOnly, async (req, reply) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    const body = asObject(req.body);
    const source = await exercises.addSqlSource(user.id, exerciseId, {
      label: str(body, 'label', { max: 200 }),
      sqlText: str(body, 'sql', { max: MAX_SOURCE_SQL_LENGTH }),
    });
    return reply.code(201).send({ source });
  });

  /**
   * The same two-step CSV flow the student's import uses — preview, then
   * confirm — reusing `previewCsv` unchanged. It is pure, it touches no
   * database, and the teacher confirming column types is the identical
   * interaction; a second implementation would be a second set of type
   * inferences to keep in step.
   *
   * JSON string rather than `multipart/form-data`, for the CSRF reason
   * `routes/workspace.ts` sets out: requiring `application/json` on every
   * state-changing call is this app's entire defence.
   */
  app.post('/api/exercises/preview', staffOnly, async (req) => {
    const body = asObject(req.body);
    return previewCsv(
      str(body, 'csv', { max: MAX_SOURCE_CSV_LENGTH }),
      optionalStr(body, 'filename', { max: 260 }) ?? '',
      {
        delimiter: optionalDelimiter(body),
        hasHeader: body['hasHeader'] === undefined ? undefined : bool(body, 'hasHeader', true),
      },
    );
  });

  app.post('/api/exercises/:id/sources/csv', staffOnly, async (req, reply) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    const body = asObject(req.body);
    const source = await exercises.addCsvSource(user.id, exerciseId, {
      label: str(body, 'label', { max: 200 }),
      csv: str(body, 'csv', { max: MAX_SOURCE_CSV_LENGTH }),
      columns: columnList(body),
      delimiter: optionalDelimiter(body),
      hasHeader: bool(body, 'hasHeader', true),
    });
    return reply.code(201).send({ source });
  });

  app.delete('/api/exercises/:id/sources/:sourceId', staffOnly, async (req) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    await exercises.removeSource(exerciseId, paramId(req, 'sourceId'));
    return { ok: true };
  });

  app.post('/api/exercises/:id/sources/order', staffOnly, async (req) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    await exercises.reorderSources(exerciseId, idList(asObject(req.body), 'ids'));
    return { exercise: await exercises.detail(exerciseId) };
  });

  // --- distribution --------------------------------------------------------

  app.post('/api/exercises/:id/classes', staffOnly, async (req) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    // The class is checked too, and separately. Owning the exercise says nothing
    // about owning the class it is being handed to, and without this a teacher
    // could distribute into somebody else's roster.
    const classId = id(asObject(req.body)['classId'], 'classId');
    await assertClassAccess(db, user, classId);
    await exercises.distribute(user.id, exerciseId, classId);
    return { exercise: await exercises.detail(exerciseId) };
  });

  /**
   * Take it back. Destructive: every student's tables in that class *and* their
   * hand-ins. `failures` is in the response rather than swallowed — one schema
   * refusing to drop leaves the other twenty-four correct, and the teacher has
   * to be able to see that it happened.
   */
  app.delete('/api/exercises/:id/classes/:classId', staffOnly, async (req) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    const classId = paramId(req, 'classId');
    await assertClassAccess(db, user, classId);
    const result = await exercises.takeBack(user.id, exerciseId, classId);
    return { ...result, exercise: await exercises.detail(exerciseId) };
  });

  // --- hand-ins, from the teacher's side -----------------------------------

  app.get('/api/exercises/:id/submissions', staffOnly, async (req) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    await assertOwnExercise(user.id, user.role, exerciseId);
    const raw = (req.query as { classId?: string }).classId;
    const classId = raw === undefined ? undefined : id(raw, 'classId');
    if (classId !== undefined) await assertClassAccess(db, user, classId);
    return { submissions: await exercises.listSubmissions(exerciseId, { classId }) };
  });

  app.get('/api/exercises/:id/submissions/:submissionId/download', staffOnly, async (req, reply) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    const exercise = await assertOwnExercise(user.id, user.role, exerciseId);
    const submission = await exercises.getSubmission(paramId(req, 'submissionId'));
    // The id belonging to *this* exercise is checked rather than assumed: the
    // ownership gate above is about the exercise in the path, and a submission
    // id from another one would otherwise ride through it.
    if (!submission || submission.exerciseId !== exerciseId) {
      throw notFound('submission_not_found', 'No such hand-in.');
    }
    return sendFile(
      reply,
      downloadName([exercise.title, submission.username, String(submission.attempt)]),
      renderSubmission(submission, exercise.title),
    );
  });

  /**
   * Everything a class handed in, as one `.sql`.
   *
   * Not a ZIP, and `services/exercise.ts`'s `renderBundle` has the argument:
   * a real archive would mean hand-writing the format to keep the runtime
   * dependency count at four, for a file a teacher reads top to bottom anyway.
   */
  app.get('/api/exercises/:id/classes/:classId/download', staffOnly, async (req, reply) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    const exercise = await assertOwnExercise(user.id, user.role, exerciseId);
    const classId = paramId(req, 'classId');
    const klass = await assertClassAccess(db, user, classId);
    const submissions = await exercises.listSubmissions(exerciseId, { classId });
    return sendFile(
      reply,
      downloadName([exercise.title, klass.code, 'abgaben']),
      renderBundle(submissions, {
        exerciseTitle: exercise.title,
        className: `${klass.code} — ${klass.name}`,
      }),
    );
  });

  // --- the student's side --------------------------------------------------

  app.get('/api/my/exercises', anyLearner, async (req) => ({
    exercises: await exercises.listForStudent(currentUser(req).id),
  }));

  /**
   * Open one: build the workspace if it is not there, and say which schema it
   * is. Idempotent, and safe to call on every page load — an existing workspace
   * answers `materialised: false` and is not touched.
   *
   * A POST rather than a GET because the first call creates a schema. That it is
   * also the natural "load this page" call is the awkward part of the shape, and
   * the alternative — a GET that silently provisions — is worse.
   */
  app.post('/api/my/exercises/:id/open', anyLearner, async (req) => {
    const user = currentUser(req);
    return exercises.openWorkspace(user.id, paramId(req));
  });

  app.post('/api/my/exercises/:id/reset', anyLearner, async (req) => {
    const user = currentUser(req);
    return exercises.resetWorkspace(user.id, paramId(req));
  });

  app.post('/api/my/exercises/:id/submissions', anyLearner, async (req, reply) => {
    const user = currentUser(req);
    const body = asObject(req.body);
    const submission = await exercises.submit(user.id, paramId(req), {
      // The same cap the editor is under, imported from where it is enforced.
      sqlText: str(body, 'sql', { max: MAX_SOURCE_SQL_LENGTH }),
      note: optionalStr(body, 'note', { max: 2000 }),
    });
    return reply.code(201).send({ submission });
  });

  app.get('/api/my/exercises/:id/submissions', anyLearner, async (req) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    if (!(await exercises.mayOpen(user.id, exerciseId))) {
      throw notFound('exercise_not_found', 'No such exercise.');
    }
    return {
      submissions: await exercises.listSubmissions(exerciseId, { userId: user.id }),
    };
  });

  app.get('/api/my/exercises/:id/submissions/:submissionId/download', anyLearner, async (req, reply) => {
    const user = currentUser(req);
    const exerciseId = paramId(req);
    const submission = await exercises.getSubmission(paramId(req, 'submissionId'));
    // Their own, and this exercise's. Both, because either alone would let a
    // student read somebody else's hand-in by guessing one number.
    if (!submission || submission.exerciseId !== exerciseId || submission.userId !== user.id) {
      throw notFound('submission_not_found', 'No such hand-in.');
    }
    const exercise = await exercises.listForStudent(user.id);
    const title = exercise.find((e) => e.id === exerciseId)?.title ?? 'Übung';
    return sendFile(
      reply,
      downloadName([title, String(submission.attempt)]),
      renderSubmission(submission, title),
    );
  });
}
