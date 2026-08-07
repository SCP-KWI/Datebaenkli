/**
 * Classes and rosters — teachers act on their own classes, admins on any.
 *
 * "Their own" is enforced by `assertClassAccess` on every single route rather
 * than by filtering the list endpoint, because a teacher who guesses a class id
 * must be refused, not merely unable to find it in a menu.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/query.js';
import type { Provisioner } from '../services/provision.js';
import { currentUser, requireRole } from '../http/auth.js';
import { forbidden, notFound } from '../http/errors.js';
import { asObject, bool, id, idList, list, maybe, optionalStr, paramId, str } from '../http/validate.js';
import {
  addMembers,
  archiveClass,
  createClass,
  getClass,
  listClasses,
  removeMember,
  updateClass,
  type SchoolClass,
} from '../services/classes.js';
import { createStudents, listStudents, type NewPerson } from '../services/users.js';
import type { SessionUser } from '../auth/session.js';

const staffOnly = { preHandler: requireRole('admin', 'teacher') };

/**
 * Exported for `routes/lesson.ts`, which needs exactly this rule and must not
 * get a second copy of it: two implementations of "is this your class" is one
 * more than can be kept correct. It stays here rather than moving into
 * `services/classes.ts` because it throws HTTP errors, which is a route-layer
 * concern — a service would throw `ServiceError` and lose the distinction
 * between "no such class" and "not yours".
 */
export async function assertClassAccess(db: Db, user: SessionUser, classId: number): Promise<SchoolClass> {
  const klass = await getClass(db, classId);
  if (!klass) throw notFound('class_not_found', 'No such class.');
  if (user.role !== 'admin' && klass.teacherId !== user.id) {
    throw forbidden('not_your_class', 'That class belongs to another teacher.');
  }
  return klass;
}

function person(entry: Record<string, unknown>): NewPerson {
  return {
    firstName: str(entry, 'firstName', { max: 80 }),
    lastName: str(entry, 'lastName', { max: 80 }),
    ...maybe('locale', optionalStr(entry, 'locale', { max: 8 })),
  };
}

export function registerClassRoutes(app: FastifyInstance, db: Db, prov: Provisioner): void {
  app.get('/api/classes', staffOnly, async (req) => {
    const user = currentUser(req);
    const includeArchived = (req.query as { includeArchived?: string }).includeArchived === 'true';
    return {
      classes: await listClasses(db, {
        ...(user.role === 'admin' ? {} : { teacherId: user.id }),
        includeArchived,
      }),
    };
  });

  app.post('/api/classes', staffOnly, async (req, reply) => {
    const user = currentUser(req);
    const body = asObject(req.body);

    // A teacher may only ever create classes for themselves. An admin has no
    // classes of their own (and no Postgres role), so they must name an owner.
    let teacherId = user.id;
    if (user.role === 'admin') {
      if (body['teacherId'] === undefined) {
        throw forbidden('teacher_required', 'An admin must say which teacher the class belongs to.');
      }
      teacherId = id(body['teacherId'], 'teacherId');
    }

    const klass = await createClass(db, user.id, {
      code: str(body, 'code', { max: 12 }),
      name: str(body, 'name', { max: 120 }),
      ...maybe('schoolYear', optionalStr(body, 'schoolYear', { max: 20 })),
      teacherId,
    });
    return reply.code(201).send({ class: klass });
  });

  app.get('/api/classes/:id', staffOnly, async (req) => {
    const user = currentUser(req);
    return { class: await assertClassAccess(db, user, paramId(req)) };
  });

  app.patch('/api/classes/:id', staffOnly, async (req) => {
    const user = currentUser(req);
    const classId = paramId(req);
    await assertClassAccess(db, user, classId);
    const body = asObject(req.body);

    if (body['teacherId'] !== undefined && user.role !== 'admin') {
      throw forbidden('admin_required', 'Only an admin can hand a class to another teacher.');
    }

    return updateClass(db, prov, user.id, classId, {
      ...maybe('name', body['name'] === undefined ? undefined : str(body, 'name', { max: 120 })),
      // Distinct from the others: an explicit empty string here means 'clear
      // the school year', so it maps to null rather than to absent.
      ...(body['schoolYear'] === undefined
        ? {}
        : { schoolYear: optionalStr(body, 'schoolYear', { max: 20 }) || null }),
      ...maybe('teacherId', body['teacherId'] === undefined ? undefined : id(body['teacherId'], 'teacherId')),
    });
  });

  app.post('/api/classes/:id/archive', staffOnly, async (req) => {
    const user = currentUser(req);
    const classId = paramId(req);
    await assertClassAccess(db, user, classId);
    return { class: await archiveClass(db, user.id, classId) };
  });

  app.get('/api/classes/:id/students', staffOnly, async (req) => {
    const user = currentUser(req);
    const classId = paramId(req);
    await assertClassAccess(db, user, classId);
    return { students: await listStudents(db, { classId }) };
  });

  /**
   * Enrol new students. Always a list — the teacher UI pastes a roster, and a
   * single student is a list of one. All-or-nothing (see createStudents).
   *
   * The response carries each student's one-time slip password; it is the only
   * time it exists in plaintext.
   */
  app.post('/api/classes/:id/students', staffOnly, async (req, reply) => {
    const user = currentUser(req);
    const classId = paramId(req);
    await assertClassAccess(db, user, classId);

    const body = asObject(req.body);
    const people = list(body, 'students', person, 200);
    const created = await createStudents(db, prov, user.id, classId, people, {
      mustChangePassword: bool(body, 'mustChangePassword', false),
    });

    return reply.code(201).send({ students: created });
  });

  /**
   * Add students who already exist — the second-subject case.
   *
   * A teacher may only add students they already have. Enrolment *is* the
   * authorisation primitive, so letting a teacher add an arbitrary user id
   * would let them grant themselves another teacher's students; see
   * `addMembers`. Moving a student across teachers is an admin action.
   */
  app.post('/api/classes/:id/members', staffOnly, async (req) => {
    const user = currentUser(req);
    const classId = paramId(req);
    await assertClassAccess(db, user, classId);
    return addMembers(
      db,
      prov,
      user.id,
      classId,
      idList(asObject(req.body), 'userIds'),
      user.role === 'admin' ? {} : { restrictToTeacherId: user.id },
    );
  });

  app.delete('/api/classes/:id/members/:userId', staffOnly, async (req) => {
    const user = currentUser(req);
    const classId = paramId(req);
    await assertClassAccess(db, user, classId);
    const provisioning = await removeMember(db, prov, user.id, classId, paramId(req, 'userId'));
    return { ok: true, provisioning };
  });
}
