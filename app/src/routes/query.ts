/**
 * Running SQL, and stopping it.
 *
 * Both routes are for the person whose database it is — a student, or a teacher
 * in their own playground schema. There is no "run this as someone else": the
 * runner resolves the Postgres identity from the session, never from the body,
 * which is what keeps the isolation invariant the app's problem to *use* rather
 * than to *enforce*.
 *
 * Admins are excluded because they have no Postgres identity at all (their
 * `app_user` row has no `pg_role`), so the runner would only be able to answer
 * `not_provisioned`. Saying so at the route is clearer than saying it at the
 * database.
 */

import type { FastifyInstance } from 'fastify';
import { currentUser, requireRole } from '../http/auth.js';
import { asObject, id, str } from '../http/validate.js';
import type { ExerciseService } from '../services/exercise.js';
import { MAX_SQL_LENGTH, type QueryRunner } from '../services/query.js';

const ownDatabaseOnly = { preHandler: requireRole('student', 'teacher') };

export function registerQueryRoutes(
  app: FastifyInstance,
  runner: QueryRunner,
  exercises: ExerciseService,
): void {
  /**
   * Run a script and return one result per statement.
   *
   * Answers 200 for a *failed* query as well as a successful one: a syntax
   * error is the expected outcome of learning SQL, not an HTTP-level problem,
   * and `{ ok: false, error: { code, message, position } }` is what the editor
   * needs to underline the character Postgres complained about. The 4xx codes
   * are reserved for things wrong with the request itself.
   *
   * `exerciseId` (phase 9) says the script belongs to an exercise rather than to
   * the caller's playground. It is an *id*, not a schema name — the service maps
   * it, so which schema this caller means is never something the browser gets to
   * assert. Absent is the ordinary case and changes nothing.
   */
  app.post('/api/query', ownDatabaseOnly, async (req) => {
    const user = currentUser(req);
    const body = asObject(req.body);
    const sql = str(body, 'sql', { max: MAX_SQL_LENGTH });
    const raw = body['exerciseId'];
    const context =
      raw === undefined || raw === null
        ? undefined
        : await exercises.workspaceFor(user.id, id(raw, 'exerciseId'));
    return runner.run(user.id, sql, context);
  });

  /**
   * The Cancel button.
   *
   * Cancels everything the caller currently has running rather than one
   * identified query, because the running query's id cannot reach the browser —
   * the response that would carry it is precisely the one still blocked. With a
   * pool of 2 per student that means a second editor tab is collateral damage;
   * the alternative is a client-generated token threaded through both routes,
   * which is more machinery than one Cancel button per page is worth.
   *
   * `{ cancelled: 0 }` is a normal answer, not an error: the query finished in
   * the gap between the click and this request.
   */
  app.post('/api/query/cancel', ownDatabaseOnly, async (req) => {
    const user = currentUser(req);
    return { cancelled: await runner.cancel(user.id) };
  });
}
