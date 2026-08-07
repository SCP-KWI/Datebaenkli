/**
 * Teacher accounts — admin only.
 *
 * The generated slip password is returned exactly once, in the create/reset
 * response. It is hashed on the way in and cannot be read back afterwards; if
 * the admin loses it before handing it over, the fix is another reset.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/query.js';
import { currentUser, requireRole } from '../http/auth.js';
import { notFound } from '../http/errors.js';
import { asObject, maybe, oneOf, optionalStr, paramId, str } from '../http/validate.js';
import type { Provisioner } from '../services/provision.js';
import {
  createTeacher,
  getUser,
  listTeachers,
  resetPassword,
  setUserState,
} from '../services/users.js';

/**
 * 'cold' is absent and stays absent. `setUserState` refuses it for a teacher
 * outright (`cold_students_only`): cold storage is a lever on student schemas,
 * and there is no `restoreTeacher` to bring one back.
 */
const SETTABLE_STATES = ['active', 'archived', 'deleted'] as const;

const adminOnly = { preHandler: requireRole('admin') };

export function registerTeacherRoutes(app: FastifyInstance, db: Db, prov: Provisioner): void {
  app.get('/api/teachers', adminOnly, async () => ({ teachers: await listTeachers(db) }));

  app.post('/api/teachers', adminOnly, async (req, reply) => {
    const actor = currentUser(req);
    const body = asObject(req.body);

    const created = await createTeacher(db, prov, actor.id, {
      firstName: str(body, 'firstName', { max: 80 }),
      lastName: str(body, 'lastName', { max: 80 }),
      // optionalStr, not str: an unselected <select> submits the empty string,
      // and 'the admin left it blank' must read as absent, not as a 400.
      ...maybe('locale', optionalStr(body, 'locale', { max: 8 })),
    });

    return reply.code(201).send(created);
  });

  app.get('/api/teachers/:id', adminOnly, async (req) => {
    const teacher = await getUser(db, paramId(req));
    if (!teacher || teacher.role !== 'teacher' || teacher.state === 'deleted') {
      throw notFound('teacher_not_found', 'No such teacher.');
    }
    return { user: teacher };
  });

  /** Issue a new slip password and end every session the teacher had open. */
  app.post('/api/teachers/:id/password', adminOnly, async (req) => {
    const actor = currentUser(req);
    const teacherId = paramId(req);

    const teacher = await getUser(db, teacherId);
    if (!teacher || teacher.role !== 'teacher') {
      throw notFound('teacher_not_found', 'No such teacher.');
    }
    return resetPassword(db, actor.id, teacherId);
  });

  /**
   * Archive or restore. There is no hard delete here: a teacher owns classes
   * (`class.teacher_id` is ON DELETE RESTRICT) and, from phase 2, a playground
   * schema. Removing the row would orphan both.
   */
  app.patch('/api/teachers/:id/state', adminOnly, async (req) => {
    const actor = currentUser(req);
    const teacherId = paramId(req);
    const state = oneOf(asObject(req.body), 'state', SETTABLE_STATES);

    const teacher = await getUser(db, teacherId);
    if (!teacher || teacher.role !== 'teacher') {
      throw notFound('teacher_not_found', 'No such teacher.');
    }
    return setUserState(db, prov, actor.id, teacherId, state);
  });
}
