/**
 * One error shape for the whole API: `{ error: { code, message } }`.
 *
 * `code` is a stable machine-readable string the frontend can branch on and the
 * i18n layer (phase 6) can key its German messages off. `message` is an English
 * fallback for developers and for curl — it is never the thing a student reads.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ServiceError } from '../services/users.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = (code = 'unauthenticated', msg = 'Not logged in.') =>
  new HttpError(401, code, msg);
export const forbidden = (code = 'forbidden', msg = 'Not allowed.') => new HttpError(403, code, msg);
export const notFound = (code = 'not_found', msg = 'Not found.') => new HttpError(404, code, msg);
export const badRequest = (code: string, msg: string) => new HttpError(400, code, msg);

/**
 * Service-level failures that are really the caller's fault, mapped to 4xx.
 * Anything not listed is a bug on our side and deserves a 500 with a stack in
 * the log, so this list stays deliberately explicit rather than defaulting to
 * 400 for every ServiceError.
 */
// `Object.create(null)`, so the map has no prototype to inherit from. As a
// plain object literal, `SERVICE_ERROR_STATUS['constructor']` returns a
// *function*, which passes the `!== undefined` guard below and reaches
// `reply.code(fn)`. Nothing can produce such a code today — every `ServiceError`
// code in the app is an internal literal — so this is closing the shape of the
// bug rather than a live path to it.
const SERVICE_ERROR_STATUS: Record<string, number> = Object.assign(Object.create(null), {
  invalid_locale: 400,
  invalid_name: 400,
  invalid_code: 400,
  empty_batch: 400,
  // --- CSV upload. A *type* the student chose being wrong is not here: that
  // answers 200 with per-cell detail, the way a failed query does.
  invalid_table_name: 400,
  duplicate_column_name: 400,
  column_count_mismatch: 400,
  empty_csv: 400,
  csv_too_many_rows: 413,
  csv_too_many_columns: 413,
  /**
   * 507, not 413. Nothing is wrong with the *request* — a 2 MB upload that
   * would be fine tomorrow is refused today because the student's schema is
   * full, and "Content Too Large" would send them looking at their file.
   * "Insufficient Storage" is literally the case, and the message names both
   * numbers so the browser's own rendering of the code never has to.
   */
  quota_exceeded: 507,
  /** The name is taken. The fix is another name or "replace", so it is a conflict. */
  table_exists: 409,
  password_too_short: 400,
  password_unchanged: 400,
  class_archived: 409,
  code_taken: 409,
  last_class: 409,
  // Resetting the schema of an archived account: the row is there, the login
  // is not. A conflict with the account's state, not a missing account.
  user_not_active: 409,
  // --- phase 5b, and both are conflicts with the account's state ---
  /** Cold storage asked for a teacher. There is no `restoreTeacher`. */
  cold_students_only: 409,
  /** `cold -> archived`, which would leave the row claiming a schema it lost. */
  restore_first: 409,
  wrong_password: 403,
  // Running SQL with no Postgres identity behind the account: an admin, or a
  // student whose provisioning has not completed. The reconciler fixes the
  // second, so this is a conflict with the account's state rather than a 404.
  not_provisioned: 409,
  /** The student's own previous query still holds every connection they get. */
  too_many_queries: 429,
  not_implemented: 501,
  // --- phase 9: exercises ---
  /**
   * A teacher's CSV fixture whose cells do not match the types they chose.
   *
   * A 400, and deliberately not the student import's `200 { ok: false, errors }`.
   * There the per-cell report *is* the lesson; here it is somebody preparing
   * material, and the only thing to do with it is fix the file.
   */
  csv_types_rejected: 400,
  too_many_sources: 409,
  /**
   * A query named an exercise whose workspace has not been built yet. A conflict
   * with the state, not a missing exercise — the fix is to open it, which is one
   * call the page already knows how to make.
   */
  exercise_not_open: 409,
  exercise_not_found: 404,
  source_not_found: 404,
  class_not_found: 404,
  teacher_not_found: 404,
  user_not_found: 404,
  member_not_found: 404,
});

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) =>
    reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.url}.` } }),
  );

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }

    if (err instanceof ServiceError) {
      const status = SERVICE_ERROR_STATUS[err.code];
      if (status !== undefined) {
        return reply.code(status).send({ error: { code: err.code, message: err.message } });
      }
    }

    // Fastify's own validation / body-parse errors already carry a status.
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply
        .code(status)
        .send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    }

    req.log.error({ err }, 'unhandled error');
    // Never echo an internal message: it can carry SQL, role names or worse.
    return reply
      .code(500)
      .send({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
  });
}
