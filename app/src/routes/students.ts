/**
 * Per-student actions that are not scoped to one class.
 *
 * Authorisation is "admin, or a teacher of a class this student is in"
 * (`teacherOwnsStudent`). A student who sits in two teachers' classes is
 * administrable by both — which is the point of the many-to-many roster.
 */

import type { FastifyInstance } from 'fastify';
import type { SessionUser } from '../auth/session.js';
import type { Db } from '../db/query.js';
import { currentUser, requireRole } from '../http/auth.js';
import { forbidden, notFound } from '../http/errors.js';
import { asObject, oneOf, paramId } from '../http/validate.js';
import type { Provisioner } from '../services/provision.js';
import {
  getUser,
  listStudents,
  resetPassword,
  resetStudentSchema,
  setUserState,
  teacherOwnsStudent,
  type PublicUser,
} from '../services/users.js';

const staffOnly = { preHandler: requireRole('admin', 'teacher') };

/**
 * What a teacher may set, and what an admin may set on top of it.
 *
 * `cold` is admin-only, per architecture §8b: it exists for instance-wide disk
 * pressure, which is not something one teacher can see or should have to judge.
 * A teacher who asks for it gets a 400 from `oneOf` naming the states they may
 * use, rather than a 403 — from where they stand it is not a state that exists.
 *
 * `deleted` stays available to teachers, and §8b calls it teacher-initiated, so
 * the split is not about which is more destructive. Deletion is about one
 * student who has left; cold is about the disk.
 */
const TEACHER_STATES = ['active', 'archived', 'deleted'] as const;
const ADMIN_STATES = ['active', 'archived', 'cold', 'deleted'] as const;

async function assertStudentAccess(
  db: Db,
  user: SessionUser,
  studentId: number,
): Promise<PublicUser> {
  const student = await getUser(db, studentId);
  if (!student || student.role !== 'student' || student.state === 'deleted') {
    throw notFound('user_not_found', 'No such student.');
  }
  if (user.role !== 'admin' && !(await teacherOwnsStudent(db, user.id, studentId))) {
    throw forbidden('not_your_student', 'That student is not in any of your classes.');
  }
  return student;
}

export function registerStudentRoutes(app: FastifyInstance, db: Db, prov: Provisioner): void {
  app.get('/api/students', staffOnly, async (req) => {
    const user = currentUser(req);
    return {
      students: await listStudents(db, user.role === 'admin' ? {} : { teacherId: user.id }),
    };
  });

  app.get('/api/students/:id', staffOnly, async (req) => {
    const user = currentUser(req);
    return { user: await assertStudentAccess(db, user, paramId(req)) };
  });

  /**
   * New slip password, shown once. Also ends the student's sessions — the usual
   * reason for a reset is that someone else knows the old one.
   */
  app.post('/api/students/:id/password', staffOnly, async (req) => {
    const user = currentUser(req);
    const studentId = paramId(req);
    await assertStudentAccess(db, user, studentId);
    return resetPassword(db, user.id, studentId);
  });

  /**
   * Archive, cold-store, restore, or delete.
   *
   * The `app_user` row always survives, for the audit trail. What changes in
   * Postgres depends on the state: archived takes the login away and leaves the
   * schema untouched, cold dumps the schema and drops it while keeping the
   * role, deleted dumps and drops both. Setting `active` on an account in cold
   * storage restores the dump — that is the one direction where the response's
   * `provisioning` field is worth reading even on the happy path, because it is
   * what says whether the tables came back.
   */
  app.patch('/api/students/:id/state', staffOnly, async (req) => {
    const user = currentUser(req);
    const studentId = paramId(req);
    await assertStudentAccess(db, user, studentId);
    const allowed = user.role === 'admin' ? ADMIN_STATES : TEACHER_STATES;
    const state = oneOf(asObject(req.body), 'state', allowed);
    return setUserState(db, prov, user.id, studentId, state);
  });

  /**
   * "Wipe my database" on the student's behalf. Drops the schema and gives
   * them an empty one, with the teacher grants put back.
   *
   * Staff-only for now; phase 3 gives the student their own button for it.
   * Irreversible and takes no dump — the schema is a scratchpad, and that is
   * exactly what makes it safe to experiment in.
   */
  app.post('/api/students/:id/reset', staffOnly, async (req) => {
    const user = currentUser(req);
    const studentId = paramId(req);
    await assertStudentAccess(db, user, studentId);
    return { ok: true, provisioning: await resetStudentSchema(db, prov, user.id, studentId) };
  });
}
