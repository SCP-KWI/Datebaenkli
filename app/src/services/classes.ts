/**
 * Classes and their rosters.
 *
 * A class belongs to exactly one teacher, but a student may sit in several
 * classes (two subjects, two teachers) — `class_member` is many-to-many. That
 * matters for phase 2: every teacher of every class a student belongs to gets
 * the read-only grant on that student's schema, so adding a member is not a
 * bookkeeping change, it is a privilege change.
 *
 * The class `code` is also part of every student's Postgres identifier
 * (`u_k3a_muster_lena`), which is why it is immutable once students exist.
 */

import type { Db, Queryable } from '../db/query.js';
import { audit } from './audit.js';
import { PROVISION_OK, tryProvision, type ProvisionOutcome, type Provisioner } from './provision.js';
import { ServiceError } from './users.js';

export type ClassState = 'active' | 'archived';

export interface SchoolClass {
  id: number;
  code: string;
  name: string;
  schoolYear: string | null;
  teacherId: number;
  teacherName: string;
  state: ClassState;
  memberCount: number;
  createdAt: string;
}

const CLASS_COLUMNS = `
  c.id, c.code, c.name, c.school_year AS "schoolYear",
  c.teacher_id AS "teacherId", t.display_name AS "teacherName",
  c.state, c.created_at AS "createdAt",
  (SELECT count(*)::int FROM class_member m
     JOIN app_user s ON s.id = m.user_id
    WHERE m.class_id = c.id AND s.state <> 'deleted') AS "memberCount"`;

/** Mirrors the `class_code_ck` CHECK constraint, so a bad code fails as 400 not 500. */
export const CLASS_CODE_PATTERN = /^[a-z0-9]{2,12}$/;

/**
 * The `pg_role` of every live student in a class.
 *
 * `state <> 'deleted'` rather than `= 'active'`: an archived student still owns
 * their schema, so a teacher change still has to move the grant on it. Skipping
 * them would strand the outgoing teacher's read access on exactly the accounts
 * nobody is looking at.
 */
async function memberRoles(q: Queryable, classId: number): Promise<string[]> {
  const { rows } = await q.query<{ pgRole: string }>(
    `SELECT u.pg_role AS "pgRole"
       FROM class_member cm JOIN app_user u ON u.id = cm.user_id
      WHERE cm.class_id = $1 AND u.pg_role IS NOT NULL AND u.state <> 'deleted'`,
    [classId],
  );
  return rows.map((r) => r.pgRole);
}

async function teacherRoleOf(q: Queryable, teacherId: number): Promise<string | null> {
  const { rows } = await q.query<{ pgRole: string | null }>(
    `SELECT pg_role AS "pgRole" FROM app_user WHERE id = $1`,
    [teacherId],
  );
  return rows[0]?.pgRole ?? null;
}

/**
 * Members of `classId` who would lose their link to `teacherId` if this class
 * stopped connecting them — i.e. everyone in it who is *not* also in another
 * class that teacher owns.
 *
 * This is the predicate that keeps a revoke from overreaching. A student takes
 * two subjects from the same teacher; the teacher hands one class over, or the
 * student drops one of them. The roster row for the other class still says
 * that teacher may read their schema, and a naive "class changed, revoke the
 * old teacher" would take that away — leaving a teacher who cannot see a
 * student sitting in front of them, with nothing in the UI to explain it.
 *
 * Run it *before* the membership is deleted (for a removal) and after the
 * class's own teacher_id has moved (for a handover); `cm2.class_id <> $1`
 * excludes this class either way.
 */
async function studentsLosingTeacher(
  q: Queryable,
  classId: number,
  teacherId: number,
): Promise<string[]> {
  const { rows } = await q.query<{ pgRole: string }>(
    `SELECT u.pg_role AS "pgRole"
       FROM class_member cm JOIN app_user u ON u.id = cm.user_id
      WHERE cm.class_id = $1 AND u.pg_role IS NOT NULL AND u.state <> 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM class_member cm2 JOIN class c2 ON c2.id = cm2.class_id
           WHERE cm2.user_id = u.id AND cm2.class_id <> $1 AND c2.teacher_id = $2
        )`,
    [classId, teacherId],
  );
  return rows.map((r) => r.pgRole);
}

export async function getClass(db: Queryable, id: number): Promise<SchoolClass | undefined> {
  const { rows } = await db.query<SchoolClass>(
    `SELECT ${CLASS_COLUMNS} FROM class c JOIN app_user t ON t.id = c.teacher_id WHERE c.id = $1`,
    [id],
  );
  return rows[0];
}

/** Admins pass no `teacherId` and see everything; teachers only ever see their own. */
export async function listClasses(
  db: Queryable,
  filter: { teacherId?: number; includeArchived?: boolean } = {},
): Promise<SchoolClass[]> {
  const { rows } = await db.query<SchoolClass>(
    `SELECT ${CLASS_COLUMNS}
       FROM class c JOIN app_user t ON t.id = c.teacher_id
      WHERE ($1::bigint IS NULL OR c.teacher_id = $1)
        AND ($2::boolean OR c.state = 'active')
      ORDER BY c.state, lower(c.code)`,
    [filter.teacherId ?? null, filter.includeArchived ?? false],
  );
  return rows;
}

export interface NewClass {
  code: string;
  name: string;
  schoolYear?: string;
  /** Admins may create a class on a teacher's behalf; teachers may not. */
  teacherId: number;
}

export async function createClass(db: Db, actorId: number, input: NewClass): Promise<SchoolClass> {
  const code = input.code.trim().toLowerCase();
  if (!CLASS_CODE_PATTERN.test(code)) {
    throw new ServiceError(
      'invalid_code',
      'A class code is 2–12 characters, lowercase letters and digits only (it becomes part of every student identifier).',
    );
  }
  const name = input.name.trim();
  if (name === '') throw new ServiceError('invalid_name', 'A class needs a name.');

  return db.tx(async (q) => {
    const { rows: teacherRows } = await q.query<{ role: string }>(
      `SELECT role FROM app_user WHERE id = $1 AND state = 'active'`,
      [input.teacherId],
    );
    const teacher = teacherRows[0];
    if (!teacher || teacher.role !== 'teacher') {
      throw new ServiceError('teacher_not_found', 'No such active teacher.');
    }

    const { rows: existing } = await q.query<{ id: number }>(
      `SELECT id FROM class WHERE lower(code) = $1`,
      [code],
    );
    if (existing.length > 0) {
      throw new ServiceError('code_taken', `The class code "${code}" is already in use.`);
    }

    const { rows } = await q.query<{ id: number }>(
      `INSERT INTO class (code, name, school_year, teacher_id) VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [code, name, input.schoolYear?.trim() || null, input.teacherId],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new ServiceError('insert_failed', 'Class row was not created.');

    await audit(q, {
      actorId,
      action: 'class_created',
      targetType: 'class',
      targetId: id,
      detail: { code, name, teacherId: input.teacherId },
    });

    const created = await getClass(q, id);
    if (!created) throw new ServiceError('insert_failed', 'Class row was not created.');
    return created;
  });
}

/**
 * Rename or reassign a class. The `code` is deliberately not updatable: it is
 * baked into every student's Postgres role and schema name, and renaming those
 * would mean re-provisioning the whole class.
 */
export async function updateClass(
  db: Db,
  prov: Provisioner,
  actorId: number,
  id: number,
  patch: { name?: string; schoolYear?: string | null; teacherId?: number },
): Promise<{ class: SchoolClass; provisioning: ProvisionOutcome }> {
  const name = patch.name?.trim();
  if (name !== undefined && name === '') {
    throw new ServiceError('invalid_name', 'A class needs a name.');
  }

  const { updated, handover } = await db.tx(async (q) => {
    const { rows: beforeRows } = await q.query<{ teacher_id: number }>(
      `SELECT teacher_id FROM class WHERE id = $1`,
      [id],
    );
    const before = beforeRows[0];
    if (!before) throw new ServiceError('class_not_found', 'No such class.');

    if (patch.teacherId !== undefined) {
      const { rows } = await q.query<{ role: string }>(
        `SELECT role FROM app_user WHERE id = $1 AND state = 'active'`,
        [patch.teacherId],
      );
      if (rows[0]?.role !== 'teacher') {
        throw new ServiceError('teacher_not_found', 'No such active teacher.');
      }
    }

    const { rows } = await q.query<{ id: number }>(
      `UPDATE class
          SET name = COALESCE($2, name),
              school_year = CASE WHEN $3::boolean THEN $4 ELSE school_year END,
              teacher_id = COALESCE($5, teacher_id)
        WHERE id = $1
        RETURNING id`,
      [
        id,
        name ?? null,
        patch.schoolYear !== undefined,
        patch.schoolYear ?? null,
        patch.teacherId ?? null,
      ],
    );
    if (rows.length === 0) throw new ServiceError('class_not_found', 'No such class.');

    await audit(q, {
      actorId,
      action: 'class_updated',
      targetType: 'class',
      targetId: id,
      // `previousTeacherId` is captured before the UPDATE on purpose: phase 2
      // has to REVOKE the outgoing teacher's USAGE on every member's schema,
      // and by this point the row itself no longer knows who that was. Leaving
      // it out would silently strand a permanent read grant on student work.
      detail: { ...patch, previousTeacherId: before.teacher_id },
    });

    const after = await getClass(q, id);
    if (!after) throw new ServiceError('class_not_found', 'No such class.');

    // Collected inside the transaction because it is the *pre-change* teacher
    // whose grants have to come off, and after COMMIT the row no longer knows
    // who that was. The roster is read here too, so a concurrent enrolment
    // cannot slip a student in between the read and the regrant unnoticed —
    // that student gets their grant from `addMembers` instead.
    const changed = patch.teacherId !== undefined && patch.teacherId !== before.teacher_id;
    if (!changed) return { updated: after, handover: null };

    return {
      updated: after,
      handover: {
        grant: await memberRoles(q, id),
        // Not every member: a student who also takes another subject from the
        // outgoing teacher keeps that link, and the grant with it.
        revoke: await studentsLosingTeacher(q, id, before.teacher_id),
        from: await teacherRoleOf(q, before.teacher_id),
        to: await teacherRoleOf(q, after.teacherId),
      },
    };
  });

  // Move the read-only grants to follow the class. Outside the transaction —
  // see `users.createStudents` for the argument. A failure here leaves the
  // outgoing teacher able to read work they no longer teach, which is why the
  // reconciler treats the roster as the authority on grants and repairs the
  // difference rather than trusting that this ran.
  let provisioning = PROVISION_OK;
  if (handover) {
    const { from, to } = handover;
    // Revoke before granting: if only one half survives a crash, the safer half
    // to have applied is the one that removes access.
    if (from !== null && from !== to) {
      for (const student of handover.revoke) {
        const out = await tryProvision(db, { actorId, pgRole: student, step: 'revokeTeacher' }, () =>
          prov.revokeTeacher(student, from),
        );
        if (!out.ok) provisioning = out;
      }
    }
    if (to !== null) {
      for (const student of handover.grant) {
        const out = await tryProvision(db, { actorId, pgRole: student, step: 'grantTeacher' }, () =>
          prov.grantTeacher(student, to),
        );
        if (!out.ok) provisioning = out;
      }
    }
  }

  return { class: updated, provisioning };
}

/**
 * Archive a class. Never deletes: the roster is the only record of who was in
 * `k3a` in 2026, and students' accounts and schemas survive independently.
 */
export async function archiveClass(db: Db, actorId: number, id: number): Promise<SchoolClass> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number }>(
      `UPDATE class SET state = 'archived' WHERE id = $1 AND state = 'active' RETURNING id`,
      [id],
    );
    if (rows.length === 0) {
      throw new ServiceError('class_not_found', 'No such active class.');
    }
    await audit(q, { actorId, action: 'class_archived', targetType: 'class', targetId: id });
    const archived = await getClass(q, id);
    if (!archived) throw new ServiceError('class_not_found', 'No such class.');
    return archived;
  });
}

/**
 * Add existing students to a class. Creating new ones is `users.createStudents`.
 *
 * `restrictToTeacherId` must be set for anyone but an admin, and limits the
 * batch to students that teacher already has. Without it, enrolment is a
 * privilege-escalation path: authorisation elsewhere is "your students are the
 * students in your classes", so a teacher who could add an arbitrary user id to
 * a class they own would thereby *acquire* that student — and could then read a
 * fresh slip password out of `POST /api/students/:id/password` and log in as
 * them. Student ids are sequential, so guessing one is free.
 *
 * Moving a student between two teachers is therefore an admin action, which is
 * the right altitude for it: it crosses the isolation boundary that the rest of
 * the model is built on (architecture §8b).
 */
export async function addMembers(
  db: Db,
  prov: Provisioner,
  actorId: number,
  classId: number,
  userIds: number[],
  options: { restrictToTeacherId?: number } = {},
): Promise<{ added: number; provisioning: ProvisionOutcome }> {
  if (userIds.length === 0) return { added: 0, provisioning: PROVISION_OK };

  const { addedCount, addedRoles, teacherRole } = await db.tx(async (q) => {
    const { rows: classRows } = await q.query<{ state: string; teacherId: number }>(
      `SELECT state, teacher_id AS "teacherId" FROM class WHERE id = $1`,
      [classId],
    );
    if (!classRows[0]) throw new ServiceError('class_not_found', 'No such class.');
    if (classRows[0].state !== 'active') {
      throw new ServiceError('class_archived', 'Cannot enrol into an archived class.');
    }

    const { rows: students } = await q.query<{ id: number }>(
      `SELECT u.id FROM app_user u
        WHERE u.id = ANY($1::bigint[]) AND u.role = 'student' AND u.state = 'active'
          AND ($2::bigint IS NULL OR EXISTS (
                SELECT 1 FROM class_member cm JOIN class c ON c.id = cm.class_id
                 WHERE cm.user_id = u.id AND c.teacher_id = $2))`,
      [userIds, options.restrictToTeacherId ?? null],
    );
    if (students.length !== userIds.length) {
      throw new ServiceError(
        'user_not_found',
        options.restrictToTeacherId === undefined
          ? 'One or more accounts are not active students.'
          : 'One or more accounts are not active students of yours. Ask an admin to move a student between teachers.',
      );
    }

    // RETURNING only reports rows the INSERT actually wrote, so a student
    // already in this class is not re-granted — and, more importantly, is not
    // counted as newly added in the audit trail.
    const { rows: added } = await q.query<{ user_id: number; pg_role: string | null }>(
      `INSERT INTO class_member (class_id, user_id)
       SELECT $1, unnest($2::bigint[])
       ON CONFLICT DO NOTHING
       RETURNING user_id, (SELECT pg_role FROM app_user WHERE id = user_id) AS pg_role`,
      [classId, userIds],
    );

    for (const row of added) {
      await audit(q, {
        actorId,
        action: 'class_member_added',
        targetType: 'class',
        targetId: classId,
        detail: { userId: row.user_id },
      });
    }

    return {
      addedCount: added.length,
      addedRoles: added.flatMap((r) => (r.pg_role === null ? [] : [r.pg_role])),
      teacherRole: await teacherRoleOf(q, classRows[0].teacherId),
    };
  });

  // Enrolment *is* a privilege change, not bookkeeping: this class's teacher
  // now gets to read these students' schemas. Granting is idempotent, so a
  // student who already had it through another of this teacher's classes is
  // simply re-granted.
  let provisioning = PROVISION_OK;
  if (teacherRole !== null) {
    for (const student of addedRoles) {
      const out = await tryProvision(db, { actorId, pgRole: student, step: 'grantTeacher' }, () =>
        prov.grantTeacher(student, teacherRole),
      );
      if (!out.ok) provisioning = out;
    }
  }

  return { added: addedCount, provisioning };
}

/**
 * Remove a student from a class. The account and its schema are untouched —
 * removing someone from a roster is not the same as deleting them, and
 * conflating the two is how a student loses a term's work.
 *
 * Refuses to remove a student from their *last* class. "Your students are the
 * students in your classes" is the rule the whole authorisation model rests on,
 * so a student in no class is reachable by nobody but an admin: invisible in
 * every roster, unrestorable, password unresettable, yet still owning a schema.
 * Moving a student means adding them to the new class first; getting rid of one
 * means setting their state to 'deleted', which archives their work properly.
 */
export async function removeMember(
  db: Db,
  prov: Provisioner,
  actorId: number,
  classId: number,
  userId: number,
): Promise<ProvisionOutcome> {
  const revoke = await db.tx(async (q) => {
    const { rows: memberships } = await q.query<{ class_id: number }>(
      `SELECT class_id FROM class_member WHERE user_id = $1`,
      [userId],
    );
    if (!memberships.some((m) => m.class_id === classId)) {
      throw new ServiceError('member_not_found', 'That student is not in this class.');
    }
    if (memberships.length === 1) {
      throw new ServiceError(
        'last_class',
        'This is the student’s only class. Add them to another one first, or delete the account instead.',
      );
    }

    // Read the teacher and the "does this student still reach them elsewhere"
    // answer *before* the DELETE, while the membership row is still there.
    const { rows: teacherRows } = await q.query<{ teacherId: number }>(
      `SELECT teacher_id AS "teacherId" FROM class WHERE id = $1`,
      [classId],
    );
    // The class was found by the membership check above, so this row exists.
    const teacherId = teacherRows[0]?.teacherId ?? null;
    const losing = teacherId === null ? [] : await studentsLosingTeacher(q, classId, teacherId);
    const teacherRole = teacherId === null ? null : await teacherRoleOf(q, teacherId);
    const { rows: studentRows } = await q.query<{ pgRole: string | null }>(
      `SELECT pg_role AS "pgRole" FROM app_user WHERE id = $1`,
      [userId],
    );
    const studentRole = studentRows[0]?.pgRole ?? null;

    await q.query(`DELETE FROM class_member WHERE class_id = $1 AND user_id = $2`, [
      classId,
      userId,
    ]);
    await audit(q, {
      actorId,
      action: 'class_member_removed',
      targetType: 'class',
      targetId: classId,
      detail: { userId },
    });

    // Only if this class was their last link to that teacher. A student taking
    // two subjects from the same teacher keeps the grant through the other one.
    if (studentRole === null || teacherRole === null || !losing.includes(studentRole)) return null;
    return { student: studentRole, teacher: teacherRole };
  });

  if (!revoke) return PROVISION_OK;
  const { student, teacher } = revoke;
  return tryProvision(db, { actorId, userId, pgRole: student, step: 'revokeTeacher' }, () =>
    prov.revokeTeacher(student, teacher),
  );
}
