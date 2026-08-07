/**
 * The live lesson view — phase 4.
 *
 * Read-only, and therefore writes no `audit_log` row: the closed union in
 * `services/audit.ts` is for destructive and administrative actions, and a
 * teacher looking at their own class's roster is neither. Every access check
 * here is the same one `routes/classes.ts` makes, reused rather than restated.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/query.js';
import { currentUser, requireRole } from '../http/auth.js';
import { notFound } from '../http/errors.js';
import { paramId } from '../http/validate.js';
import type { CatalogReader, CatalogSchema } from '../services/catalog.js';
import { assertClassAccess } from './classes.js';
import { clampWindow, type LessonReader } from '../services/lesson.js';
import { ServiceError } from '../services/users.js';

const staffOnly = { preHandler: requireRole('admin', 'teacher') };

/**
 * `minutes` off the query string.
 *
 * Not in `http/validate.ts`: that file validates JSON bodies, where a wrong
 * type is a caller mistake worth a 400. A query string is always text and a
 * nonsense value here has an obvious right answer — the default — so this
 * clamps instead of rejecting. A teacher fiddling with a URL should not get an
 * error page in the middle of a lesson.
 */
function windowMinutes(req: FastifyRequest): number {
  const raw = (req.query as { minutes?: string }).minutes;
  return clampWindow(raw === undefined ? undefined : Number(raw));
}

export function registerLessonRoutes(
  app: FastifyInstance,
  db: Db,
  lesson: LessonReader,
  catalog: CatalogReader,
): void {
  app.get('/api/lesson/classes/:id', staffOnly, async (req) => {
    const user = currentUser(req);
    const classId = paramId(req);
    await assertClassAccess(db, user, classId);
    return lesson.read(classId, windowMinutes(req));
  });

  /**
   * One student: their recent statements, and their schema as the caller may
   * see it.
   *
   * The schema half is read through `catalog.read(<the caller>)`, not through
   * the student's own identity — so what comes back is whatever Postgres shows
   * *this teacher*, decided by the USAGE grant that follows the roster, not by
   * a filter written here. It is the same call the schema browser makes; the
   * only thing this adds is picking one schema out of the tree.
   *
   * An admin has no Postgres role at all (ARCHITECTURE §2), so for them there
   * is nothing to read and `schema` is null. That is the honest answer: the app
   * is not going to re-read it as `dbk_app` to fill the pane, because then the
   * pane would be showing something no grant entitles anyone to.
   */
  app.get('/api/lesson/classes/:id/students/:userId', staffOnly, async (req) => {
    const user = currentUser(req);
    const classId = paramId(req);
    await assertClassAccess(db, user, classId);

    const detail = await lesson.detail(classId, paramId(req, 'userId'));
    if (!detail) throw notFound('student_not_found', 'No such student in this class.');

    let schema: CatalogSchema | null = null;
    if (detail.student.pgRole !== null) {
      try {
        const tree = await catalog.read(user.id);
        schema = tree.schemas.find((s) => s.name === detail.student.pgRole) ?? null;
      } catch (err) {
        // `not_provisioned` is the admin case above and is not an error worth
        // failing the whole request over — the statements are the point of this
        // route and they are already in hand. Anything else is a real fault.
        if (!(err instanceof ServiceError && err.code === 'not_provisioned')) throw err;
      }
    }

    return { ...detail, schema };
  });
}
