import assert from 'node:assert/strict';
import test from 'node:test';
import { dist, freshMeta } from './support/meta-db.mjs';

const users = await import(dist('services/users.js'));
const classes = await import(dist('services/classes.js'));
const sessions = await import(dist('auth/session.js'));
const provision = await import(dist('services/provision.js'));
const lifecycle = await import(dist('services/lifecycle.js'));
const { decryptSecret } = await import(dist('crypto/secretbox.js'));

/**
 * The provisioner handed to every service call below.
 *
 * PGlite cannot execute a single GRANT, so the real engine
 * (services/provision.ts) is exercised by test/provision.live.test.mjs against
 * a real cluster. What this fake covers is the half that is *not* SQL: which
 * calls the seams decide to make. Whether removing a student from one of two
 * classes taught by the same teacher revokes that teacher's grant is a decision
 * made in classes.ts, and it is wrong in a way no SQL test would catch.
 *
 * Reassigned by `fresh()`, so each test starts with an empty recording. Safe
 * because node:test runs the tests in one file sequentially.
 */
let prov = provision.recordingProvisioner();

/** The recorded calls to one operation, as plain argument arrays. */
const callsTo = (op) => prov.calls.filter((c) => c.op === op).map((c) => c.args);

async function fresh(options = {}) {
  prov = provision.recordingProvisioner(options);
  return freshMeta();
}

/** admin -> teacher -> class, the setup almost every test below needs. */
async function withClass(code = 'k3a', options = {}) {
  const { db, adminId } = await fresh(options);
  const { user: teacher } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Philip',
    lastName: 'Schaffner',
  });
  const klass = await classes.createClass(db, adminId, {
    code,
    name: 'Klasse 3a',
    teacherId: teacher.id,
  });
  return { db, adminId, teacher, klass };
}

// --- creating accounts -------------------------------------------------------

test('a new teacher gets a t_ role, a slip password, and a forced change', async () => {
  const { db, adminId } = await fresh();
  const { user, password } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Philip',
    lastName: 'Schaffner',
  });

  assert.equal(user.username, 't_schaffner');
  assert.equal(user.pgRole, 't_schaffner', 'role and login are the same string');
  assert.equal(user.role, 'teacher');
  assert.match(password, /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
  assert.equal(user.mustChangePassword, true, 'staff must not stay on a printed password');

  assert.ok(await users.authenticate(db, 't_schaffner', password));
});

test('the Postgres password is generated at creation and stored encrypted', async () => {
  // Phase 2 reads this to run CREATE ROLE, so it must be present and decryptable
  // without any further write to app_user.
  const { db, adminId } = await fresh();
  const { user } = await users.createTeacher(db, prov, adminId, { firstName: 'A', lastName: 'B' });

  const { rows } = await db.query(`SELECT pg_password_enc FROM app_user WHERE id = $1`, [user.id]);
  const stored = rows[0].pg_password_enc;
  assert.ok(stored?.startsWith('v1.'), 'should be an AES-GCM envelope');
  assert.ok(decryptSecret(stored).length >= 32, 'should decrypt to a full-strength password');
});

test('students are named u_<class>_<surname>_<firstname> and enrolled in the class', async () => {
  const { db, teacher, klass } = await withClass();
  const created = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
    { firstName: 'Tim', lastName: 'Meier' },
  ]);

  assert.deepEqual(
    created.map((c) => c.user.username),
    ['u_k3a_muster_lena', 'u_k3a_meier_tim'],
  );
  assert.equal(created[0].user.mustChangePassword, false, 'the slip password is the credential');

  const roster = await users.listStudents(db, { classId: klass.id });
  assert.equal(roster.length, 2);
  // Sorted by pg_role, i.e. by surname — what a printed roster wants.
  assert.deepEqual(roster.map((s) => s.displayName), ['Tim Meier', 'Lena Muster']);
});

test('two students with the same name in one paste get distinct identifiers', async () => {
  const { db, teacher, klass } = await withClass();
  const created = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  assert.deepEqual(
    created.map((c) => c.user.username),
    ['u_k3a_muster_lena', 'u_k3a_muster_lena2'],
  );
});

test('a failed batch enrols nobody', async () => {
  const { db, teacher, klass } = await withClass();
  await assert.rejects(
    () =>
      users.createStudents(db, prov, teacher.id, klass.id, [
        { firstName: 'Lena', lastName: 'Muster' },
        { firstName: '', lastName: '' },
      ]),
    /needs a name/,
  );
  assert.equal(
    (await users.listStudents(db, { classId: klass.id })).length,
    0,
    'the first student must have been rolled back with the second',
  );
});

test('each student gets a different slip password', async () => {
  const { db, teacher, klass } = await withClass();
  const created = await users.createStudents(
    db,
    prov,
    teacher.id,
    klass.id,
    Array.from({ length: 12 }, (_, i) => ({ firstName: `S${i}`, lastName: 'Test' })),
  );
  assert.equal(new Set(created.map((c) => c.password)).size, 12);
});

test('enrolling into an archived class is refused', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  await classes.archiveClass(db, adminId, klass.id);
  await assert.rejects(
    () => users.createStudents(db, prov, teacher.id, klass.id, [{ firstName: 'A', lastName: 'B' }]),
    /archived/,
  );
});

// --- authentication ----------------------------------------------------------

test('authentication rejects wrong passwords, unknown users and archived accounts', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const [{ user, password }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  assert.ok(await users.authenticate(db, user.username, password));
  assert.equal(await users.authenticate(db, user.username, 'wrong'), false);
  assert.equal(await users.authenticate(db, 'u_k3a_nobody', password), false);

  await users.setUserState(db, prov, adminId, user.id, 'archived');
  assert.equal(
    await users.authenticate(db, user.username, password),
    false,
    'an archived account must not be able to log in',
  );
});

test('a username is matched case-insensitively', async () => {
  const { db, teacher, klass } = await withClass();
  const [{ user, password }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  assert.ok(await users.authenticate(db, user.username.toUpperCase(), password));
});

test('a successful login stamps last_login_at', async () => {
  const { db, teacher, klass } = await withClass();
  const [{ user, password }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  assert.equal(user.lastLoginAt, null);
  await users.authenticate(db, user.username, password);
  assert.ok((await users.getUser(db, user.id)).lastLoginAt);
});

// --- sessions ----------------------------------------------------------------

test('a session resolves to its user and dies when destroyed', async () => {
  const { db, teacher } = await withClass();
  const { token } = await sessions.createSession(db, teacher.id, { ip: '10.0.0.1' });

  const loaded = await sessions.loadSession(db, token);
  assert.equal(loaded.user.id, teacher.id);
  assert.equal(loaded.user.pgRole, 't_schaffner');

  await sessions.destroySession(db, token);
  assert.equal(await sessions.loadSession(db, token), null);
});

test('the raw session token is never stored', async () => {
  // A read of the session table must not yield anything replayable as a cookie.
  const { db, teacher } = await withClass();
  const { token } = await sessions.createSession(db, teacher.id);
  const { rows } = await db.query('SELECT id FROM session');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, token);
  assert.equal(await sessions.loadSession(db, rows[0].id), null, 'the stored value is not a key');
});

test('an expired session does not resolve, and gets swept', async () => {
  const { db, teacher } = await withClass();
  const { token } = await sessions.createSession(db, teacher.id);
  await db.query(`UPDATE session SET expires_at = now() - interval '1 minute'`);

  assert.equal(await sessions.loadSession(db, token), null);
  assert.equal(await sessions.sweepExpiredSessions(db), 1);
  assert.equal((await db.query('SELECT id FROM session')).rows.length, 0);
});

test('archiving a user cuts their sessions immediately', async () => {
  const { db, adminId, teacher } = await withClass();
  const { token } = await sessions.createSession(db, teacher.id);
  await users.setUserState(db, prov, adminId, teacher.id, 'archived');
  assert.equal(await sessions.loadSession(db, token), null);
});

test('a garbage cookie value resolves to nothing rather than throwing', async () => {
  const { db } = await fresh();
  assert.equal(await sessions.loadSession(db, 'not-a-real-token'), null);
  assert.equal(await sessions.loadSession(db, ''), null);
});

// --- passwords ---------------------------------------------------------------

test('changing your own password requires the current one and logs other devices out', async () => {
  const { db, teacher, klass } = await withClass();
  const [{ user, password }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  const { token } = await sessions.createSession(db, user.id);

  await assert.rejects(
    () => users.changeOwnPassword(db, user.id, 'not-the-password', 'ein-neues-passwort'),
    /not correct/,
  );
  await assert.rejects(
    () => users.changeOwnPassword(db, user.id, password, 'kurz'),
    /at least 10 characters/,
  );
  await assert.rejects(
    () => users.changeOwnPassword(db, user.id, password, password),
    /not used here before/,
  );

  await users.changeOwnPassword(db, user.id, password, 'ein-neues-passwort');
  assert.ok(await users.authenticate(db, user.username, 'ein-neues-passwort'));
  assert.equal(await users.authenticate(db, user.username, password), false);
  assert.equal(await sessions.loadSession(db, token), null, 'old sessions must not survive');
  assert.equal((await users.getUser(db, user.id)).mustChangePassword, false);
});

test('a reset issues a new slip password and invalidates the old one', async () => {
  const { db, teacher, klass } = await withClass();
  const [{ user, password }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  const { token } = await sessions.createSession(db, user.id);

  const reset = await users.resetPassword(db, teacher.id, user.id);
  assert.notEqual(reset.password, password);
  assert.equal(await users.authenticate(db, user.username, password), false);
  assert.ok(await users.authenticate(db, user.username, reset.password));
  assert.equal(await sessions.loadSession(db, token), null);
});

// --- classes and rosters -----------------------------------------------------

test('class codes must be slugs, and are unique', async () => {
  const { db, adminId, teacher } = await withClass();
  await assert.rejects(
    () => classes.createClass(db, adminId, { code: 'K 3a!', name: 'x', teacherId: teacher.id }),
    /2–12 characters/,
  );
  await assert.rejects(
    () => classes.createClass(db, adminId, { code: 'k3a', name: 'x', teacherId: teacher.id }),
    /already in use/,
  );
});

test('a class can only be owned by an active teacher', async () => {
  const { db, adminId } = await fresh();
  await assert.rejects(
    () => classes.createClass(db, adminId, { code: 'k3a', name: 'x', teacherId: adminId }),
    /No such active teacher/,
  );
  await assert.rejects(
    () => classes.createClass(db, adminId, { code: 'k3a', name: 'x', teacherId: 9999 }),
    /No such active teacher/,
  );
});

test('a teacher sees only their own classes; an admin sees all', async () => {
  const { db, adminId, teacher } = await withClass();
  const { user: other } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Anna',
    lastName: 'Beispiel',
  });
  await classes.createClass(db, adminId, { code: 'k4b', name: 'Klasse 4b', teacherId: other.id });

  assert.deepEqual(
    (await classes.listClasses(db, { teacherId: teacher.id })).map((c) => c.code),
    ['k3a'],
  );
  assert.deepEqual((await classes.listClasses(db)).map((c) => c.code), ['k3a', 'k4b']);
});

test('a student in two classes is visible to both teachers', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const { user: other } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Anna',
    lastName: 'Beispiel',
  });
  const second = await classes.createClass(db, adminId, {
    code: 'k4b',
    name: 'Klasse 4b',
    teacherId: other.id,
  });
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  assert.equal(await users.teacherOwnsStudent(db, other.id, student.id), false);
  // Across teachers, so it takes an admin (see the escalation test below).
  assert.equal((await classes.addMembers(db, prov, adminId, second.id, [student.id])).added, 1);
  assert.equal(await users.teacherOwnsStudent(db, other.id, student.id), true);
  assert.equal(await users.teacherOwnsStudent(db, teacher.id, student.id), true);

  // Adding the same student twice is a no-op, not an error.
  assert.equal((await classes.addMembers(db, prov, adminId, second.id, [student.id])).added, 0);
});

test('a student cannot be removed from their only class', async () => {
  // Otherwise the account is reachable by nobody but an admin: in no roster,
  // so not restorable and not resettable, yet still owning a schema.
  const { db, teacher, klass } = await withClass();
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  await assert.rejects(
    () => classes.removeMember(db, prov, teacher.id, klass.id, student.id),
    /only class/,
  );
  assert.equal((await users.listStudents(db, { classId: klass.id })).length, 1);
});

test('removing a student from one of several classes leaves the account alone', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const second = await classes.createClass(db, adminId, {
    code: 'k4b',
    name: 'Klasse 4b',
    teacherId: teacher.id,
  });
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  await classes.addMembers(db, prov, teacher.id, second.id, [student.id]);

  await classes.removeMember(db, prov, teacher.id, klass.id, student.id);
  assert.equal((await users.listStudents(db, { classId: klass.id })).length, 0);
  assert.equal((await users.listStudents(db, { classId: second.id })).length, 1);

  const survivor = await users.getUser(db, student.id);
  assert.equal(survivor.state, 'active', 'the account and its schema must survive');
  assert.equal(
    await users.teacherOwnsStudent(db, teacher.id, student.id),
    true,
    'still administrable through the remaining class',
  );

  await assert.rejects(
    () => classes.removeMember(db, prov, teacher.id, klass.id, student.id),
    /not in this class/,
  );
});

test('memberCount ignores deleted students', async () => {
  const { db, teacher, klass } = await withClass();
  const created = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
    { firstName: 'Tim', lastName: 'Meier' },
  ]);
  assert.equal((await classes.getClass(db, klass.id)).memberCount, 2);
  await users.setUserState(db, prov, teacher.id, created[0].user.id, 'deleted');
  assert.equal((await classes.getClass(db, klass.id)).memberCount, 1);
});

test('a class code cannot be changed, because student identifiers embed it', async () => {
  const { db, adminId, klass } = await withClass();
  const { class: updated } = await classes.updateClass(db, prov, adminId, klass.id, {
    name: 'Klasse 3a (2026)',
    code: 'zzz',
  });
  assert.equal(updated.name, 'Klasse 3a (2026)');
  assert.equal(updated.code, 'k3a');
});

// --- lifecycle ---------------------------------------------------------------

test('a deleted identifier is never handed out again', async () => {
  // pg_role is also the schema name. If the out-of-band DROP SCHEMA has not run
  // (or failed), reusing the name would drop the next Lena Muster straight into
  // the previous one's schema — search_path is "$user", public.
  const { db, teacher, klass } = await withClass();
  const [{ user: first }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  await users.setUserState(db, prov, teacher.id, first.id, 'deleted');

  const [{ user: second }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  assert.equal(first.username, 'u_k3a_muster_lena');
  assert.equal(second.username, 'u_k3a_muster_lena2');
  assert.notEqual(second.id, first.id, 'the old row is kept for audit');
});

test('a reset forces staff to change, but not students', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  const resetStudent = await users.resetPassword(db, teacher.id, student.id);
  assert.equal(resetStudent.user.mustChangePassword, false, 'the slip password is the credential');

  const resetTeacher = await users.resetPassword(db, adminId, teacher.id);
  assert.equal(
    resetTeacher.user.mustChangePassword,
    true,
    'an account that administers others must not stay on a password read out over the phone',
  );
});

test('archived_at survives the later transition to deleted', async () => {
  // It is what phase 5's retention job keys off to decide what is safe to drop.
  const { db, teacher, klass } = await withClass();
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  await users.setUserState(db, prov, teacher.id, student.id, 'archived');
  const archivedAt = (
    await db.query('SELECT archived_at FROM app_user WHERE id = $1', [student.id])
  ).rows[0].archived_at;
  assert.ok(archivedAt, 'archiving should stamp it');

  await users.setUserState(db, prov, teacher.id, student.id, 'deleted');
  const afterDelete = (
    await db.query('SELECT archived_at FROM app_user WHERE id = $1', [student.id])
  ).rows[0].archived_at;
  assert.deepEqual(afterDelete, archivedAt, 'deleting must not erase it');
});

test('a teacher cannot enrol another teacher’s student', async () => {
  // Enrolment IS the authorisation primitive: adding a student to your class
  // makes them yours, so an unrestricted add would let any teacher grant
  // themselves a colleague's students and then read their slip passwords.
  const { db, adminId, teacher, klass } = await withClass();
  const { user: other } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Anna',
    lastName: 'Beispiel',
  });
  const theirs = await classes.createClass(db, adminId, {
    code: 'k4b',
    name: 'Klasse 4b',
    teacherId: other.id,
  });
  const [{ user: victim }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  await assert.rejects(
    () => classes.addMembers(db, prov, other.id, theirs.id, [victim.id], { restrictToTeacherId: other.id }),
    /not active students of yours/,
  );
  assert.equal(await users.teacherOwnsStudent(db, other.id, victim.id), false);

  // An admin may, because moving a student across teachers is an admin action.
  assert.equal((await classes.addMembers(db, prov, adminId, theirs.id, [victim.id])).added, 1);
  assert.equal(await users.teacherOwnsStudent(db, other.id, victim.id), true);
});

test('a duplicated id in one batch is not read as a missing account', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const second = await classes.createClass(db, adminId, {
    code: 'k4b',
    name: 'Klasse 4b',
    teacherId: teacher.id,
  });
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  // idList dedupes; addMembers compares row count against the input length, so
  // without that a double-clicked [42, 42] would report student 42 as unknown.
  assert.equal((await classes.addMembers(db, prov, teacher.id, second.id, [student.id])).added, 1);
});

test('an archived student can be restored', async () => {
  const { db, teacher, klass } = await withClass();
  const [{ user, password }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  await users.setUserState(db, prov, teacher.id, user.id, 'archived');
  assert.ok((await users.getUser(db, user.id)).state === 'archived');

  const { user: restored } = await users.setUserState(db, prov, teacher.id, user.id, 'active');
  assert.equal(restored.state, 'active');
  assert.ok(await users.authenticate(db, user.username, password));
});

test('an admin account cannot be archived out of existence', async () => {
  // Locking the last admin out is unrecoverable without shell access.
  const { db, adminId } = await fresh();
  await assert.rejects(() => users.setUserState(db, prov, adminId, adminId, 'archived'), /admin/);
});

// --- phase 5b: cold storage and the archive sweep ----------------------------
//
// Everything here is about *which seams a transition decides to call* and what
// it records — the half of the lifecycle that is not SQL. Whether the dump and
// the restore actually work belongs to lifecycle.live.test.mjs, because PGlite
// has no roles, no pg_dump and no second database.

const ARCHIVE = '/tmp/dbk-archive/u_k3a_muster_lena-2026-07-28.dump';

/** admin -> teacher -> class -> one student, the setup every case below needs. */
async function withStudent(options = {}) {
  const { db, adminId, teacher, klass } = await withClass('k3a', options);
  const [{ user, password }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  return { db, adminId, teacher, klass, student: user, password };
}

test('cold storage is refused for a teacher', async () => {
  // There is no restoreTeacher, so a cold teacher would be a one-way door.
  const { db, adminId, teacher } = await withClass();
  await assert.rejects(
    () => users.setUserState(db, prov, adminId, teacher.id, 'cold'),
    /Only a student/,
  );
});

test('cold storage dumps, and records where the dump went', async () => {
  const { db, adminId, student } = await withStudent({ archivePath: ARCHIVE });

  const { user } = await users.setUserState(db, prov, adminId, student.id, 'cold');
  assert.equal(user.state, 'cold');
  // coldStore, not archiveAndDrop: the schema is the disk, the role is not.
  assert.deepEqual(callsTo('coldStore'), [[student.pgRole]]);
  assert.equal(callsTo('archiveAndDrop').length, 0);

  const { rows } = await db.query('SELECT archive_path, archived_at FROM app_user WHERE id = $1', [
    student.id,
  ]);
  assert.equal(rows[0].archive_path, ARCHIVE);
  assert.ok(rows[0].archived_at, 'cold is an archival event and wants a timestamp');
});

test('a cold account comes back by restoring, never by ensuring', async () => {
  // The §4dd hazard as a deliberate transition: `ensureStudent` here would make
  // an empty schema and orphan the dump.
  const { db, adminId, student } = await withStudent({ archivePath: ARCHIVE });
  await users.setUserState(db, prov, adminId, student.id, 'cold');

  const { user } = await users.setUserState(db, prov, adminId, student.id, 'active');
  assert.equal(user.state, 'active');

  const restores = callsTo('restoreStudent');
  assert.equal(restores.length, 1);
  assert.equal(restores[0][0].archivePath, ARCHIVE);
  assert.equal(restores[0][0].canLogin, true);
  assert.deepEqual(restores[0][0].teacherRoles, ['t_schaffner']);

  // Cleared only once the restore succeeded — the column means "there is work
  // in a file", and after this there is not.
  const { rows } = await db.query('SELECT archive_path FROM app_user WHERE id = $1', [student.id]);
  assert.equal(rows[0].archive_path, null);
});

test('a failed restore keeps the dump path, so the reconciler can retry', async () => {
  const { db, adminId, student } = await withStudent({ archivePath: ARCHIVE });
  await users.setUserState(db, prov, adminId, student.id, 'cold');

  prov = provision.recordingProvisioner({
    archivePath: ARCHIVE,
    failing: { restoreStudent: 'archive volume is not mounted' },
  });
  const { user, provisioning } = await users.setUserState(db, prov, adminId, student.id, 'active');

  // The row moves, the teaching database lags, and the response says so —
  // the same asymmetry a failed deletion has, chosen for the same reason.
  assert.equal(user.state, 'active');
  assert.equal(provisioning.ok, false);
  const { rows } = await db.query('SELECT archive_path FROM app_user WHERE id = $1', [student.id]);
  assert.equal(rows[0].archive_path, ARCHIVE, 'the only copy of the work must stay named');
});

test('cold cannot be archived: it would claim a schema it no longer has', async () => {
  const { db, adminId, student } = await withStudent({ archivePath: ARCHIVE });
  await users.setUserState(db, prov, adminId, student.id, 'cold');
  await assert.rejects(
    () => users.setUserState(db, prov, adminId, student.id, 'archived'),
    /cold storage/,
  );
});

test('nor can an ACTIVE account whose restore failed and left the dump named', async () => {
  // The two-hop route, which review found and which the one-hop guard missed:
  // the row already says active, so a guard keyed on `state === 'cold'` waves
  // it through and the account ends up claiming a schema it has not got.
  const { db, adminId, student } = await withStudent({ archivePath: ARCHIVE });
  await users.setUserState(db, prov, adminId, student.id, 'cold');

  prov = provision.recordingProvisioner({
    archivePath: ARCHIVE,
    failing: { restoreStudent: 'archive volume is not mounted' },
  });
  await users.setUserState(db, prov, adminId, student.id, 'active');
  assert.equal((await users.getUser(db, student.id)).state, 'active');

  await assert.rejects(
    () => users.setUserState(db, prov, adminId, student.id, 'archived'),
    /cold storage/,
  );
});

test('and the sweep does not reach for one either', async () => {
  // Same state, reached by nobody clicking anything. Without the archive_path
  // filter the sweep would pick this account up every night and throw on it.
  const { db, adminId, student } = await withStudent({ archivePath: ARCHIVE });
  await users.setUserState(db, prov, adminId, student.id, 'cold');
  prov = provision.recordingProvisioner({
    archivePath: ARCHIVE,
    failing: { restoreStudent: 'archive volume is not mounted' },
  });
  await users.setUserState(db, prov, adminId, student.id, 'active');
  await db.query(`UPDATE app_user SET last_active_at = now() - interval '400 days' WHERE id = $1`, [
    student.id,
  ]);

  const report = await lifecycle.sweepInactiveStudents(db, prov, adminId);
  assert.deepEqual(report.archived, []);
  assert.deepEqual(report.failed, []);
  assert.equal(report.considered, 0, 'an account with work in a file is not a sweep candidate');
});

test('one impossible account does not abandon the rest of the sweep', async () => {
  // The candidate list is a SELECT, not a lock: a teacher deleting a student
  // between the SELECT and that student's turn makes `setUserState` throw, and
  // an unguarded loop would skip every remaining account and write no summary.
  const { db, teacher, klass, adminId } = await withClass();
  const created = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
    { firstName: 'Tim', lastName: 'Beispiel' },
  ]);
  const [first, doomed] = created.map((c) => c.user);
  await db.query(`UPDATE app_user SET last_active_at = now() - interval '400 days'`);

  // Both are candidates when the SELECT runs. The second is deleted while the
  // first is being archived — the interleaving the try/catch exists for, which
  // deleting it up front would not reproduce, because the sweep's own
  // `state = 'active'` filter would simply never have selected it.
  const base = provision.recordingProvisioner();
  prov = {
    ...base,
    async setLogin(pgRole, canLogin) {
      if (pgRole === first.pgRole) {
        await db.query(`UPDATE app_user SET state = 'deleted' WHERE id = $1`, [doomed.id]);
      }
      return base.setLogin(pgRole, canLogin);
    },
  };

  const report = await lifecycle.sweepInactiveStudents(db, prov, adminId);

  assert.deepEqual(report.archived.map((c) => c.username), [first.username]);
  assert.equal(report.failed.length, 1, 'the account that vanished is reported, not thrown');
  assert.match(report.failed[0].error, /No such account/);
  assert.equal((await users.getUser(db, first.id)).state, 'archived');

  const { rows } = await db.query(`SELECT detail FROM audit_log WHERE action = 'archive_swept'`);
  assert.equal(rows.length, 1, 'the accounts that were archived must still be reported');
  assert.deepEqual(rows[0].detail.archived, [first.username]);
});

test('deleting a cold account does not blank the name of its dump', async () => {
  // archiveAndDrop finds no schema and returns null; that null must not
  // overwrite the path of the only copy of the student's work.
  const { db, adminId, student } = await withStudent({ archivePath: ARCHIVE });
  await users.setUserState(db, prov, adminId, student.id, 'cold');

  prov = provision.recordingProvisioner(); // archiveAndDrop -> null
  await users.setUserState(db, prov, adminId, student.id, 'deleted');

  const { rows } = await db.query('SELECT archive_path FROM app_user WHERE id = $1', [student.id]);
  assert.equal(rows[0].archive_path, ARCHIVE);
});

test('the sweep archives the idle and leaves everyone else alone', async () => {
  const { db, teacher, klass, adminId } = await withClass();
  const created = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
    { firstName: 'Tim', lastName: 'Beispiel' },
    { firstName: 'Sara', lastName: 'Neu' },
  ]);
  const [idle, active, fresh] = created.map((c) => c.user);

  await db.query(`UPDATE app_user SET last_active_at = now() - interval '400 days' WHERE id = $1`, [
    idle.id,
  ]);
  await db.query(`UPDATE app_user SET last_active_at = now() - interval '3 days' WHERE id = $1`, [
    active.id,
  ]);
  // `fresh` keeps last_active_at NULL — a student holding an unused slip. It is
  // created_at that decides for them, which is why the sweep coalesces.
  await db.query(`UPDATE app_user SET created_at = now() - interval '400 days' WHERE id = $1`, [
    fresh.id,
  ]);

  const report = await lifecycle.sweepInactiveStudents(db, prov, adminId);
  assert.deepEqual(
    report.archived.map((c) => c.username).sort(),
    [idle.username, fresh.username].sort(),
  );

  assert.equal((await users.getUser(db, active.id)).state, 'active');
  assert.equal((await users.getUser(db, idle.id)).state, 'archived');
  // Through the real setUserState, which is the entire argument for the sweep
  // living in this process: NOLOGIN follows without a second implementation.
  assert.deepEqual(
    callsTo('setLogin')
      .filter(([, canLogin]) => canLogin === false)
      .map(([role]) => role)
      .sort(),
    [idle.pgRole, fresh.pgRole].sort(),
  );
});

test('the sweep never touches a teacher, however idle', async () => {
  // A teacher's schema is not what fills a disk, and NOLOGIN on one mid-year
  // takes a class down with it.
  const { db, teacher, adminId } = await withClass();
  await db.query(`UPDATE app_user SET last_active_at = now() - interval '999 days'`);

  const report = await lifecycle.sweepInactiveStudents(db, prov, adminId);
  assert.equal(report.archived.length, 0);
  assert.equal((await users.getUser(db, teacher.id)).state, 'active');
});

test('a sweep that archives nobody writes no audit row', async () => {
  const { db, adminId } = await withStudent();
  const before = await db.query('SELECT count(*)::int AS n FROM audit_log');
  await lifecycle.sweepInactiveStudents(db, prov, adminId);
  const after = await db.query('SELECT count(*)::int AS n FROM audit_log');
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test('a swept account says so in the audit trail, and names the batch', async () => {
  // §8b asks that archival never be silent. There is no mail path; this and the
  // roster's greyed-out row are what "flags the owning teacher" amounts to.
  const { db, adminId, student } = await withStudent();
  await db.query(`UPDATE app_user SET last_active_at = now() - interval '400 days' WHERE id = $1`, [
    student.id,
  ]);
  await lifecycle.sweepInactiveStudents(db, prov, null);

  const { rows } = await db.query(
    `SELECT action, actor_id, detail FROM audit_log
      WHERE action IN ('user_state_changed', 'archive_swept') ORDER BY id`,
  );
  const perAccount = rows.find((r) => r.action === 'user_state_changed');
  assert.equal(perAccount.detail.via, 'sweep', 'a row must say why it was archived');
  assert.equal(perAccount.actor_id, null, 'nobody pressed anything');

  const summary = rows.find((r) => r.action === 'archive_swept');
  assert.deepEqual(summary.detail.archived, [student.username]);
  assert.equal(summary.detail.afterDays, 365);
});

test('the next sweep is at the configured hour, tomorrow if today has passed', async () => {
  // Recomputed from a fresh Date rather than a 24 h interval, so the sweep does
  // not drift to whenever the container last restarted.
  const before = new Date(2026, 6, 28, 3, 39, 0);
  assert.equal(lifecycle.msUntilNextSweep(before), 60_000);

  const after = new Date(2026, 6, 28, 3, 41, 0);
  const target = new Date(2026, 6, 29, 3, 40, 0);
  assert.equal(lifecycle.msUntilNextSweep(after), target.getTime() - after.getTime());
});

// --- audit -------------------------------------------------------------------

test('every administrative action leaves an audit row', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  await users.resetPassword(db, teacher.id, student.id);
  await users.setUserState(db, prov, teacher.id, student.id, 'archived');

  const { rows } = await db.query('SELECT action, actor_id FROM audit_log ORDER BY id');
  assert.deepEqual(
    rows.map((r) => r.action),
    [
      'teacher_created',
      'class_created',
      'student_created',
      'password_reset',
      'user_state_changed',
    ],
  );
  assert.equal(rows.at(-1).actor_id, teacher.id, 'the actor, not the target, is recorded');
});

// --- profile -----------------------------------------------------------------

test('locale is validated against the supported set', async () => {
  const { db, teacher } = await withClass();
  assert.equal((await users.updateProfile(db, teacher.id, { locale: 'en' })).locale, 'en');
  await assert.rejects(() => users.updateProfile(db, teacher.id, { locale: 'fr' }), /de, en/);
});

// --- provisioning seams ------------------------------------------------------
//
// What the services *decide* to ask the teaching database for. The SQL those
// decisions turn into is checked by test/provision.live.test.mjs against a real
// cluster; PGlite cannot run a GRANT. The two halves are complementary, and
// this is the half where the interesting bugs live — a revoke that fires when
// the student is still taught by that teacher is a correct GRANT statement
// issued at the wrong moment.

test('creating a teacher asks for their playground schema', async () => {
  const { db, adminId } = await fresh();
  const { user, provisioning } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Philip',
    lastName: 'Schaffner',
  });

  assert.equal(provisioning.ok, true);
  const [[spec]] = callsTo('ensureTeacher');
  assert.equal(spec.pgRole, 't_schaffner');
  assert.equal(spec.canLogin, true);

  // The password handed to CREATE ROLE must be the one the account row stores,
  // or the app authenticates against Postgres with a string nothing recognises.
  const { rows } = await db.query('SELECT pg_password_enc FROM app_user WHERE id = $1', [user.id]);
  assert.equal(spec.pgPassword, decryptSecret(rows[0].pg_password_enc));
});

test('creating students provisions each one with their class teacher’s grant', async () => {
  const { db, teacher, klass } = await withClass();
  await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
    { firstName: 'Tim', lastName: 'Meier' },
  ]);

  const specs = callsTo('ensureStudent').map(([s]) => ({
    pgRole: s.pgRole,
    canLogin: s.canLogin,
    teacherRoles: s.teacherRoles,
  }));
  assert.deepEqual(specs, [
    { pgRole: 'u_k3a_muster_lena', canLogin: true, teacherRoles: ['t_schaffner'] },
    { pgRole: 'u_k3a_meier_tim', canLogin: true, teacherRoles: ['t_schaffner'] },
  ]);
});

test('a provisioning failure is reported, not thrown, and leaves an audit row', async () => {
  // The account row has already committed by this point. Failing the request
  // would claim nothing happened, when in fact the student exists and is in the
  // roster — they just have no schema yet. Report it and let reconcile repair.
  const { db, teacher, klass } = await withClass();
  const broken = provision.recordingProvisioner({
    failing: { ensureStudent: 'connection refused' },
  });

  const [created] = await users.createStudents(db, broken, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  assert.equal(created.provisioning.ok, false);
  assert.match(created.provisioning.error, /connection refused/);
  assert.equal(created.user.username, 'u_k3a_muster_lena', 'the account still exists');

  const { rows } = await db.query(
    `SELECT detail FROM audit_log WHERE action = 'provision_failed'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail.step, 'ensureStudent');
  assert.equal(rows[0].detail.pgRole, 'u_k3a_muster_lena');
});

test('archiving takes the Postgres login away and restoring puts it back', async () => {
  const { db, teacher, klass } = await withClass();
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  await users.setUserState(db, prov, teacher.id, student.id, 'archived');
  assert.deepEqual(callsTo('setLogin'), [['u_k3a_muster_lena', false]]);

  // Restoring is a full ensure, not just LOGIN: an account whose role never got
  // created must come back working, not come back half-created.
  await users.setUserState(db, prov, teacher.id, student.id, 'active');
  const restored = callsTo('ensureStudent').at(-1)[0];
  assert.equal(restored.pgRole, 'u_k3a_muster_lena');
  assert.equal(restored.canLogin, true);
  assert.deepEqual(restored.teacherRoles, ['t_schaffner']);
});

test('deleting dumps the schema to the archive before dropping it', async () => {
  const { db, teacher, klass } = await withClass();
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  const { provisioning } = await users.setUserState(db, prov, teacher.id, student.id, 'deleted');
  assert.equal(provisioning.ok, true);
  assert.deepEqual(callsTo('archiveAndDrop'), [['u_k3a_muster_lena']]);

  const { rows } = await db.query(
    `SELECT action FROM audit_log WHERE action = 'user_deprovisioned'`,
  );
  assert.equal(rows.length, 1);
});

test('a failed archive dump does not drop the schema, and is reported', async () => {
  // The one irreversible failure in the whole phase. `archiveAndDrop` refuses
  // to drop if pg_dump failed, so the work survives; all this checks is that
  // the caller is told rather than shown a success.
  const { db, teacher, klass } = await withClass();
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  const broken = provision.recordingProvisioner({
    failing: { archiveAndDrop: 'pg_dump of schema u_k3a_muster_lena failed' },
  });

  const { user, provisioning } = await users.setUserState(db, broken, teacher.id, student.id, 'deleted');
  assert.equal(user.state, 'deleted', 'the account is out of use either way');
  assert.equal(provisioning.ok, false);
  assert.match(provisioning.error, /pg_dump/);

  const { rows } = await db.query(
    `SELECT action FROM audit_log WHERE action IN ('user_deprovisioned', 'provision_failed')`,
  );
  assert.deepEqual(rows.map((r) => r.action), ['provision_failed'], 'must not claim it was archived');
});

test('handing a class to another teacher moves the read-only grants', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const { user: other } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Anna',
    lastName: 'Beispiel',
  });
  await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  await classes.updateClass(db, prov, adminId, klass.id, { teacherId: other.id });

  assert.deepEqual(callsTo('revokeTeacher'), [['u_k3a_muster_lena', 't_schaffner']]);
  assert.deepEqual(callsTo('grantTeacher'), [['u_k3a_muster_lena', 't_beispiel']]);
});

test('enrolling an existing student grants that class’s teacher', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const { user: other } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Anna',
    lastName: 'Beispiel',
  });
  const second = await classes.createClass(db, adminId, {
    code: 'k4b',
    name: 'Klasse 4b',
    teacherId: other.id,
  });
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  await classes.addMembers(db, prov, adminId, second.id, [student.id]);
  assert.deepEqual(callsTo('grantTeacher'), [['u_k3a_muster_lena', 't_beispiel']]);
});

test('removing a student revokes only the teacher they no longer have', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const { user: other } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Anna',
    lastName: 'Beispiel',
  });
  const second = await classes.createClass(db, adminId, {
    code: 'k4b',
    name: 'Klasse 4b',
    teacherId: other.id,
  });
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  await classes.addMembers(db, prov, adminId, second.id, [student.id]);

  await classes.removeMember(db, prov, adminId, second.id, student.id);
  assert.deepEqual(callsTo('revokeTeacher'), [['u_k3a_muster_lena', 't_beispiel']]);
});

test('a student in two classes of the SAME teacher keeps the grant', async () => {
  // The overreach this guards against: "class membership changed, revoke the
  // old teacher" would take away access the student's other subject still
  // grants — leaving a teacher unable to see a student sitting in front of them.
  const { db, adminId, teacher, klass } = await withClass();
  const second = await classes.createClass(db, adminId, {
    code: 'k4b',
    name: 'Klasse 4b',
    teacherId: teacher.id,
  });
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  await classes.addMembers(db, prov, adminId, second.id, [student.id]);

  await classes.removeMember(db, prov, teacher.id, klass.id, student.id);
  assert.deepEqual(callsTo('revokeTeacher'), [], 'still their teacher through k4b');
});

test('a handover leaves a shared student alone if the outgoing teacher keeps them', async () => {
  const { db, adminId, teacher, klass } = await withClass();
  const { user: other } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Anna',
    lastName: 'Beispiel',
  });
  const alsoMine = await classes.createClass(db, adminId, {
    code: 'k4b',
    name: 'Klasse 4b',
    teacherId: teacher.id,
  });
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  await classes.addMembers(db, prov, adminId, alsoMine.id, [student.id]);

  await classes.updateClass(db, prov, adminId, klass.id, { teacherId: other.id });

  assert.deepEqual(callsTo('revokeTeacher'), [], 't_schaffner still teaches them in k4b');
  assert.deepEqual(callsTo('grantTeacher').at(-1), ['u_k3a_muster_lena', 't_beispiel']);
});

test('resetting a schema re-grants the teachers, because DROP SCHEMA took them', async () => {
  const { db, teacher, klass } = await withClass();
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);

  const outcome = await users.resetStudentSchema(db, prov, teacher.id, student.id);
  assert.equal(outcome.ok, true);
  assert.deepEqual(callsTo('resetSchema'), [['u_k3a_muster_lena', ['t_schaffner']]]);

  const { rows } = await db.query(`SELECT action FROM audit_log WHERE action = 'schema_reset'`);
  assert.equal(rows.length, 1);
});

test('an archived student cannot be reset', async () => {
  const { db, teacher, klass } = await withClass();
  const [{ user: student }] = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  await users.setUserState(db, prov, teacher.id, student.id, 'archived');
  await assert.rejects(
    () => users.resetStudentSchema(db, prov, teacher.id, student.id),
    /active account/,
  );
});

// --- the live lesson view (phase 4) ------------------------------------------

const lessonSvc = await import(dist('services/lesson.js'));

const QUOTA_BYTES = 1024 * 1024;

/** A `query_log` row at a chosen age, which is what every window test needs. */
async function logStatement(db, userId, sql, { minutesAgo = 0, errorCode = null } = {}) {
  await db.query(
    `INSERT INTO query_log (user_id, sql_text, duration_ms, row_count, error_code, error_message, created_at)
     VALUES ($1, $2, 12, 3, $3, $4, now() - ($5 || ' minutes')::interval)`,
    [userId, sql, errorCode, errorCode ? 'kaputt' : null, String(minutesAgo)],
  );
}

/**
 * Two students in one class, with a lesson reader pointed at them.
 *
 * `workspaces` maps a student's id to the exercise schemas they hold, which the
 * reader sums into their disk figure. Defaulting it to "nobody has any" keeps
 * every pre-phase-9 case reading exactly as it did; the one case that cares
 * passes a map and a matching `usage`.
 */
async function withLesson(usage = [], workspaces = new Map()) {
  const { db, adminId, teacher, klass } = await withClass('k3a', { usage });
  const created = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
    { firstName: 'Tim', lastName: 'Bühler' },
  ]);
  const reader = lessonSvc.makeLessonReader({
    db,
    prov,
    quotaBytes: QUOTA_BYTES,
    workspacesByUser: async () => workspaces,
  });
  const by = (name) => created.find((c) => c.user.displayName.startsWith(name)).user;
  return { db, adminId, teacher, klass, reader, lena: by('Lena'), tim: by('Tim') };
}

test('a student who has run nothing is present with zeros, not absent', async () => {
  const { klass, reader, lena } = await withLesson();
  const view = await reader.read(klass.id);

  assert.equal(view.students.length, 2);
  const row = view.students.find((s) => s.userId === lena.id);
  assert.equal(row.lastStatement, null);
  assert.equal(row.statements, 0);
  assert.equal(row.errors, 0);
  assert.equal(row.signedIn, false, 'never logged in');
});

test('counts respect the window; the last statement ignores it', async () => {
  const { db, klass, reader, lena } = await withLesson();
  await logStatement(db, lena.id, 'SELECT 1', { minutesAgo: 200 });
  await logStatement(db, lena.id, 'SELECT 2', { minutesAgo: 10 });
  await logStatement(db, lena.id, 'SELECT boom', { minutesAgo: 5, errorCode: '42601' });

  const view = await reader.read(klass.id, 90);
  const row = view.students.find((s) => s.userId === lena.id);

  assert.equal(row.statements, 2, 'the 200-minute-old one is outside the window');
  assert.equal(row.errors, 1);
  // The point of the DISTINCT ON having no window bound: "last thing they ran
  // was hours ago" beats an empty cell.
  assert.equal(row.lastStatement.sql, 'SELECT boom');
  assert.equal(row.lastStatement.errorCode, '42601');

  const wide = await reader.read(klass.id, 240);
  assert.equal(wide.students.find((s) => s.userId === lena.id).statements, 3);
});

test('a student with only old statements still shows the last one', async () => {
  const { db, klass, reader, tim } = await withLesson();
  await logStatement(db, tim.id, 'SELECT alt', { minutesAgo: 300 });

  const row = (await reader.read(klass.id, 30)).students.find((s) => s.userId === tim.id);
  assert.equal(row.statements, 0);
  assert.equal(row.lastStatement.sql, 'SELECT alt');
});

test('signedIn follows an unexpired session and nothing else', async () => {
  const { db, klass, reader, lena, tim } = await withLesson();
  await sessions.createSession(db, lena.id, {});
  await db.query(
    `INSERT INTO session (id, user_id, expires_at) VALUES ('stale', $1, now() - interval '1 hour')`,
    [tim.id],
  );

  const view = await reader.read(klass.id);
  assert.equal(view.students.find((s) => s.userId === lena.id).signedIn, true);
  assert.equal(
    view.students.find((s) => s.userId === tim.id).signedIn,
    false,
    'an expired session is not a session',
  );
});

/**
 * The reason the quota is in this view at all — HANDOFF §4s.
 *
 * A refused student writes no query_log row, so activity alone cannot tell them
 * apart from a student who has typed nothing. If this assertion ever fails, the
 * lesson view has gone back to rendering "refused on every keystroke" and
 * "hasn't started" identically.
 */
test('an over-quota student is visible as such even having run nothing', async () => {
  const { klass, reader, lena, tim } = await withLesson([
    { schema: 'u_k3a_muster_lena', bytes: QUOTA_BYTES * 3 },
  ]);

  const view = await reader.read(klass.id);
  const stuck = view.students.find((s) => s.userId === lena.id);
  const fine = view.students.find((s) => s.userId === tim.id);

  assert.equal(stuck.lastStatement, null, 'a refusal writes no query_log row');
  assert.equal(stuck.quota.overQuota, true, 'and the view says so anyway');
  assert.equal(stuck.quota.bytes, QUOTA_BYTES * 3);

  // A provisioned student with no tables is 0 bytes, which is a real answer and
  // not "unknown" — only a missing pg_role is unknown.
  assert.equal(fine.quota.bytes, 0);
  assert.equal(fine.quota.overQuota, false);
});

test('the view asks about its own class’s schemas, never the whole instance', async () => {
  const { klass, reader, lena, tim } = await withLesson();
  await reader.read(klass.id);

  const [args] = callsTo('schemaUsage');
  assert.ok(Array.isArray(args[0]), 'a filter was passed');
  assert.deepEqual(
    [...args[0]].sort(),
    [lena.pgRole, tim.pgRole].sort(),
    'schemaUsage() unfiltered would name every other teacher’s students',
  );
});

test('a student’s disk is their playground plus their exercise workspaces', async () => {
  // Phase 9. The failure this pins is silent and gets worse the more a class
  // uses the feature: measure only the schema named after the student and a
  // teacher reads "12 of 50 MB" for someone who is about to be refused a write.
  //
  // Two students, and only one holds a workspace, so the assertion also catches
  // the other half — summing everyone's workspaces into everyone's total.
  const { klass, reader, lena, tim } = await withLesson(
    [
      { schema: 'u_k3a_muster_lena', bytes: 1_000 },
      { schema: 'x1_u_k3a_muster_lena', bytes: 4_000 },
      { schema: 'x2_u_k3a_muster_lena', bytes: 500 },
      { schema: 'u_k3a_buehler_tim', bytes: 7_000 },
    ],
    new Map([[3, ['x1_u_k3a_muster_lena', 'x2_u_k3a_muster_lena']]]),
  );
  // The map above is keyed by id, and `withLesson` creates Lena first — assert
  // that rather than trusting it, or this test silently measures nobody.
  assert.equal(lena.id, 3, 'the workspace map above is keyed on this id');

  const view = await reader.read(klass.id);
  assert.equal(view.students.find((s) => s.userId === lena.id).quota.bytes, 5_500);
  assert.equal(view.students.find((s) => s.userId === tim.id).quota.bytes, 7_000);

  // And the widened list is still scoped to this class rather than the instance.
  const [args] = callsTo('schemaUsage');
  assert.deepEqual(
    [...args[0]].sort(),
    ['u_k3a_buehler_tim', 'u_k3a_muster_lena', 'x1_u_k3a_muster_lena', 'x2_u_k3a_muster_lena'],
  );
});

test('the window is clamped rather than rejected', async () => {
  const { klass, reader } = await withLesson();
  assert.equal((await reader.read(klass.id, 0)).windowMinutes, lessonSvc.MIN_WINDOW_MINUTES);
  assert.equal((await reader.read(klass.id, 99999)).windowMinutes, lessonSvc.MAX_WINDOW_MINUTES);
  assert.equal((await reader.read(klass.id, Number.NaN)).windowMinutes, lessonSvc.DEFAULT_WINDOW_MINUTES);
});

test('detail returns the newest statements first, and refuses another class’s student', async () => {
  const { db, adminId, teacher, klass, reader, lena } = await withLesson();
  await logStatement(db, lena.id, 'SELECT alt', { minutesAgo: 30 });
  await logStatement(db, lena.id, 'SELECT neu', { minutesAgo: 1 });

  const detail = await reader.detail(klass.id, lena.id);
  assert.equal(detail.statements.length, 2);
  assert.equal(detail.statements[0].sql, 'SELECT neu');
  assert.equal(detail.student.displayName, lena.displayName);

  // Enrolment is the authorisation primitive: a student id that is not on this
  // class's roster is a 404 even for the teacher who owns them elsewhere.
  const other = await classes.createClass(db, adminId, {
    code: 'k4b',
    name: 'Klasse 4b',
    teacherId: teacher.id,
  });
  assert.equal(await reader.detail(other.id, lena.id), undefined);
});
