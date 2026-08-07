/**
 * Accounts: teachers, students, and everyone's own profile.
 *
 * Two databases, and the split between them is the thing to keep straight.
 * `app_user` rows are written here, in the meta database, inside a transaction.
 * The Postgres role and schema that back them live in the *teaching* database
 * and are created by `provision.ts` — always after that transaction has
 * committed, never inside it, because two databases cannot share one.
 *
 * The account row carries the *intended* identity from the moment it is
 * created: `pg_role`, and a `pg_password_enc` generated up front so
 * provisioning never has to write back here. That is what makes a crashed run
 * repairable — the record of what should exist is complete and durable before
 * anything is attempted, and `reconcile.ts` can replay it.
 */

import { generateDbPassword, generateSlipPassword, hashPassword, verifyPassword } from '../auth/password.js';
import { allocateIdentifier, studentIdentifier, teacherIdentifier } from '../auth/identifiers.js';
import { destroyUserSessions } from '../auth/session.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto/secretbox.js';
import type { Db, Queryable } from '../db/query.js';
import { audit } from './audit.js';
import {
  PROVISION_OK,
  tryProvision,
  type ProvisionOutcome,
  type Provisioner,
} from './provision.js';

export type AppRole = 'admin' | 'teacher' | 'student';
export type UserState = 'active' | 'archived' | 'cold' | 'deleted';

// There is deliberately no exported `SETTABLE_STATES` here any more. It used to
// list what an API caller could ask for, and phase 5b would have had to add
// 'cold' to it — at which point it becomes a shared constant that *looks* like
// an authorisation list, is exported from the service layer, and grants every
// teacher the ability to dump and drop a student's schema the moment a route
// imports it for convenience. The real gate is per-route and per-role
// (`TEACHER_STATES` / `ADMIN_STATES` in routes/students.ts), because that is
// where the caller's role is known. `setUserState` enforces what is true
// regardless of who is asking: 'cold' is students-only, and an account with a
// dump on disk cannot be archived.

export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  role: AppRole;
  state: UserState;
  locale: string;
  mustChangePassword: boolean;
  pgRole: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** A freshly created account, with the one-time password to put on the slip. */
export interface CreatedUser {
  user: PublicUser;
  password: string;
  /**
   * Whether the Postgres side landed. Absent on paths that touch no role at
   * all (a slip-password reset), `{ ok: false }` when the account exists but
   * its schema does not — which is a real state, not an error, and one the
   * reconciler clears up.
   */
  provisioning?: ProvisionOutcome;
}

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

// --- reading -----------------------------------------------------------------

/**
 * The public projection of `app_user`, qualified by table alias — `class` also
 * has `id`, `state` and `created_at`, so every column has to say which table it
 * came from once a roster query joins the two.
 */
function userColumns(alias = 'app_user'): string {
  const a = `${alias}.`;
  return `
  ${a}id, ${a}username, ${a}display_name AS "displayName", ${a}role, ${a}state,
  ${a}locale, ${a}must_change_password AS "mustChangePassword",
  ${a}pg_role AS "pgRole", ${a}created_at AS "createdAt",
  ${a}last_login_at AS "lastLoginAt"`;
}

const USER_COLUMNS = userColumns();

export async function getUser(db: Queryable, id: number): Promise<PublicUser | undefined> {
  const { rows } = await db.query<PublicUser>(
    `SELECT ${USER_COLUMNS} FROM app_user WHERE app_user.id = $1`,
    [id],
  );
  return rows[0];
}

export async function listTeachers(db: Queryable): Promise<PublicUser[]> {
  const { rows } = await db.query<PublicUser>(
    `SELECT ${USER_COLUMNS} FROM app_user
      WHERE role = 'teacher' AND state <> 'deleted'
      ORDER BY lower(display_name)`,
  );
  return rows;
}

export interface StudentFilter {
  classId?: number;
  /** Restrict to students in classes owned by this teacher. Ignored for admins. */
  teacherId?: number;
}

/**
 * Students, optionally narrowed to one class and/or one teacher's classes.
 *
 * Sorted by `pg_role`, which is `u_<class>_<surname>_<firstname>` — so a roster
 * comes out grouped by class and alphabetical by surname without needing
 * separate name columns.
 */
export async function listStudents(db: Queryable, filter: StudentFilter = {}): Promise<PublicUser[]> {
  const { rows } = await db.query<PublicUser>(
    `SELECT DISTINCT ${userColumns('u')}
       FROM app_user u
       JOIN class_member cm ON cm.user_id = u.id
       JOIN class c ON c.id = cm.class_id
      WHERE u.role = 'student' AND u.state <> 'deleted'
        AND ($1::bigint IS NULL OR c.id = $1)
        AND ($2::bigint IS NULL OR c.teacher_id = $2)
      ORDER BY "pgRole"`,
    [filter.classId ?? null, filter.teacherId ?? null],
  );
  return rows;
}

/**
 * Everything the teaching database needs to know about one account.
 *
 * `teacherRoles` is every teacher of every class the student sits in — the
 * roster is many-to-many, so a student taking two subjects is legitimately
 * readable by two teachers. It comes out empty for a teacher's own account,
 * which is correct: nobody gets a grant on a teacher's playground schema.
 */
export interface PgIdentity {
  userId: number;
  role: AppRole;
  state: UserState;
  pgRole: string;
  pgPassword: string;
  teacherRoles: string[];
  /**
   * Where this account's schema was last dumped, or null.
   *
   * The one fact about an account that cannot be re-derived by asking Postgres
   * — the dump is a file outside both databases — which is why migration 002
   * gives it a column at all. Read here rather than separately because every
   * caller that needs it already needs the rest of the identity, and because
   * `state` beside it is what makes the pair meaningful: cold plus a path is a
   * schema in storage, active plus a path is a restore that did not finish.
   */
  archivePath: string | null;
}

interface IdentityRow {
  id: number;
  role: AppRole;
  state: UserState;
  pgRole: string | null;
  pgPasswordEnc: string | null;
  archivePath: string | null;
  teacherRoles: string[];
}

const IDENTITY_QUERY = `
  SELECT u.id, u.role, u.state,
         u.pg_role AS "pgRole", u.pg_password_enc AS "pgPasswordEnc",
         u.archive_path AS "archivePath",
         coalesce(
           array_agg(DISTINCT t.pg_role) FILTER (WHERE t.pg_role IS NOT NULL),
           '{}'
         ) AS "teacherRoles"
    FROM app_user u
    LEFT JOIN class_member cm ON cm.user_id = u.id
    LEFT JOIN class c         ON c.id = cm.class_id
    LEFT JOIN app_user t      ON t.id = c.teacher_id AND t.state <> 'deleted'
   WHERE u.id = ANY($1::bigint[])
   GROUP BY u.id`;

/**
 * Decrypt the stored role password.
 *
 * Returns undefined rather than throwing when the row has no Postgres identity
 * (an admin) — but *does* let a decryption failure through, because that means
 * DBK_ENCRYPTION_KEY has changed and silently provisioning a role with a
 * password nobody holds would be worse than a loud failure.
 */
function toIdentity(row: IdentityRow): PgIdentity | undefined {
  if (row.pgRole === null || row.pgPasswordEnc === null) return undefined;
  return {
    userId: row.id,
    role: row.role,
    state: row.state,
    pgRole: row.pgRole,
    pgPassword: decryptSecret(row.pgPasswordEnc),
    teacherRoles: row.teacherRoles,
    archivePath: row.archivePath,
  };
}

export async function pgIdentity(db: Queryable, userId: number): Promise<PgIdentity | undefined> {
  const { rows } = await db.query<IdentityRow>(IDENTITY_QUERY, [[userId]]);
  const row = rows[0];
  return row ? toIdentity(row) : undefined;
}

/** The same, in bulk. Used by the reconciler, which reads the whole instance. */
export async function pgIdentities(db: Queryable, userIds: number[]): Promise<PgIdentity[]> {
  if (userIds.length === 0) return [];
  const { rows } = await db.query<IdentityRow>(IDENTITY_QUERY, [userIds]);
  return rows.flatMap((row) => {
    const identity = toIdentity(row);
    return identity ? [identity] : [];
  });
}

/** True if `teacherId` owns at least one class this student sits in. */
export async function teacherOwnsStudent(
  db: Queryable,
  teacherId: number,
  studentId: number,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM class_member cm JOIN class c ON c.id = cm.class_id
      WHERE cm.user_id = $1 AND c.teacher_id = $2
      LIMIT 1`,
    [studentId, teacherId],
  );
  return rows.length > 0;
}

// --- authentication ----------------------------------------------------------

let dummyHash: Promise<string> | undefined;

/**
 * Verify a password against a throwaway hash so that "no such user" costs the
 * same ~100 ms as "wrong password". Without it, response time tells an attacker
 * which usernames exist — and our usernames are guessable by construction
 * (`u_k3a_muster_lena`).
 */
async function equalCostReject(password: string): Promise<false> {
  dummyHash ??= hashPassword('datebaenkli-timing-equaliser');
  await verifyPassword(password, await dummyHash);
  return false;
}

/**
 * Check credentials. Returns the user on success, false otherwise — never a
 * reason, since distinguishing "wrong password" from "archived account" to an
 * unauthenticated caller leaks membership.
 */
export async function authenticate(
  db: Queryable,
  username: string,
  password: string,
): Promise<PublicUser | false> {
  const { rows } = await db.query<PublicUser & { passwordHash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash"
       FROM app_user
      WHERE lower(username) = lower($1) AND state = 'active'`,
    [username],
  );

  const row = rows[0];
  if (!row) return equalCostReject(password);
  if (!(await verifyPassword(password, row.passwordHash))) return false;

  await db.query(`UPDATE app_user SET last_login_at = now(), last_active_at = now() WHERE id = $1`, [
    row.id,
  ]);

  const { passwordHash: _ignored, ...user } = row;
  return user;
}

// --- creating ----------------------------------------------------------------

/**
 * Every username and pg_role ever issued. Both must be free for a name to be
 * usable.
 *
 * Deliberately includes `deleted` rows, even though the unique indexes are
 * partial on `state <> 'deleted'` and would permit reuse. A student's pg_role
 * is also their *schema* name, and deletion drops that schema out-of-band
 * (phase 2). If the drop has not run, or failed, or its archive dump errored,
 * re-issuing the name would drop the next Lena Muster straight into the
 * previous one's schema — `search_path` is `"$user", public`, so she would own
 * every table in it without doing anything. Names are free; that is not.
 */
async function takenIdentifiers(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ username: string; pg_role: string | null }>(
    `SELECT username, pg_role FROM app_user`,
  );
  const taken = new Set<string>();
  for (const r of rows) {
    taken.add(r.username);
    if (r.pg_role) taken.add(r.pg_role);
  }
  return taken;
}

function checkLocale(locale: string): string {
  if (!(config.i18n.supported as readonly string[]).includes(locale)) {
    throw new ServiceError('invalid_locale', `Locale must be one of ${config.i18n.supported.join(', ')}.`);
  }
  return locale;
}

export interface NewPerson {
  firstName: string;
  lastName: string;
  locale?: string;
}

/**
 * A slip password and its hash, prepared before any transaction is open.
 *
 * scrypt deliberately costs ~100 ms and 16 MB per hash. Doing that *inside* a
 * transaction would pin a pool connection — one of ten — for the whole batch,
 * and a pasted class of 25 would hold it for two seconds of pure CPU while
 * every concurrent login queued behind it on the same libuv threadpool.
 */
interface PreparedCredential {
  password: string;
  passwordHash: string;
  /**
   * The Postgres role password, in the clear.
   *
   * Generated here rather than read back from `pg_password_enc` after the
   * INSERT, so the value the account row will carry and the value handed to
   * `CREATE ROLE` are provably the same string. Round-tripping it through the
   * database would work until the day the encryption key changed under us, and
   * then would produce a role whose password nothing can recover.
   */
  dbPassword: string;
}

async function prepareCredential(): Promise<PreparedCredential> {
  const password = generateSlipPassword();
  return {
    password,
    passwordHash: await hashPassword(password),
    dbPassword: generateDbPassword(),
  };
}

/**
 * Insert an account. `identifier` is used as both the app username and the
 * Postgres role/schema name — see auth/identifiers.ts for why they are one
 * string.
 */
async function insertUser(
  db: Queryable,
  input: {
    identifier: string;
    displayName: string;
    role: Exclude<AppRole, 'admin'>;
    locale: string;
    passwordHash: string;
    dbPassword: string;
    mustChangePassword: boolean;
    createdBy: number;
  },
): Promise<PublicUser> {
  const { rows } = await db.query<PublicUser>(
    `INSERT INTO app_user
       (username, display_name, role, locale, password_hash, must_change_password,
        pg_role, pg_password_enc, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $1, $7, $8)
     RETURNING ${USER_COLUMNS}`,
    [
      input.identifier,
      input.displayName,
      input.role,
      input.locale,
      input.passwordHash,
      input.mustChangePassword,
      // Encrypted at rest, and handed to `CREATE ROLE` moments later by the
      // caller. Storing it before the role exists — rather than after — means
      // provisioning never writes back to this table, so a run that dies
      // halfway leaves no torn state, only a missing role the reconciler sees.
      encryptSecret(input.dbPassword),
      input.createdBy,
    ],
  );

  const user = rows[0];
  if (!user) throw new ServiceError('insert_failed', 'Account row was not created.');
  return user;
}

/**
 * The `app_user_pg_role_ck` CHECK already guarantees this for every non-admin,
 * so reaching the throw means the schema and this code disagree. Better a
 * named 500 here than `undefined` interpolated into a `CREATE ROLE`.
 */
function requirePgRole(user: PublicUser): string {
  if (user.pgRole === null) {
    throw new ServiceError('missing_pg_role', `Account ${user.username} has no Postgres identity.`);
  }
  return user.pgRole;
}

export async function createTeacher(
  db: Db,
  prov: Provisioner,
  actorId: number,
  input: NewPerson,
): Promise<CreatedUser> {
  const locale = checkLocale(input.locale ?? config.i18n.defaultLocale);
  const displayName = `${input.firstName} ${input.lastName}`.trim();
  if (displayName === '') {
    throw new ServiceError('invalid_name', 'A teacher needs a name.');
  }
  const { password, passwordHash, dbPassword } = await prepareCredential();

  const user = await db.tx(async (q) => {
    const identifier = allocateIdentifier(
      teacherIdentifier(input.lastName, input.firstName),
      await takenIdentifiers(q),
    );
    const created = await insertUser(q, {
      identifier,
      displayName,
      locale,
      role: 'teacher',
      passwordHash,
      dbPassword,
      // Teachers administer other people's accounts; they should not stay on a
      // password that was printed and handed over.
      mustChangePassword: true,
      createdBy: actorId,
    });
    await audit(q, {
      actorId,
      action: 'teacher_created',
      targetType: 'app_user',
      targetId: created.id,
      detail: { username: created.username },
    });
    return created;
  });

  // The teacher's playground schema. Outside the transaction above — see the
  // note at the top of this file, and `createStudents` for the full argument.
  const pgRole = requirePgRole(user);
  const provisioning = await tryProvision(
    db,
    { actorId, userId: user.id, pgRole, step: 'ensureTeacher' },
    () => prov.ensureTeacher({ pgRole, pgPassword: dbPassword, canLogin: true }),
  );

  return { user, password, provisioning };
}

/**
 * Create a batch of students in one class, in one transaction.
 *
 * Bulk by construction — the teacher UI pastes a name list, and a single
 * student is simply a list of one. All-or-nothing matters: a half-imported
 * class with an unclear boundary is worse to clean up than a failed import.
 */
export async function createStudents(
  db: Db,
  prov: Provisioner,
  actorId: number,
  classId: number,
  people: NewPerson[],
  options: { mustChangePassword?: boolean } = {},
): Promise<CreatedUser[]> {
  if (people.length === 0) throw new ServiceError('empty_batch', 'No students given.');

  // Validate and hash the whole batch *before* opening the transaction: these
  // steps need no database, and scrypt on 25 students would otherwise hold a
  // pool connection for seconds (see prepareCredential). Concurrently, because
  // Node hands scrypt to the threadpool.
  const prepared = await Promise.all(
    people.map(async (person) => {
      const displayName = `${person.firstName} ${person.lastName}`.trim();
      if (displayName === '') throw new ServiceError('invalid_name', 'A student needs a name.');
      return {
        person,
        displayName,
        locale: checkLocale(person.locale ?? config.i18n.defaultLocale),
        credential: await prepareCredential(),
      };
    }),
  );

  const { created, teacherRole } = await db.tx(async (q) => {
    // The teacher comes out of the same lookup as the class code: a brand-new
    // student is in exactly one class, so their whole grant list is this one
    // role, and fetching it here saves a second round trip after the commit.
    const { rows: classRows } = await q.query<{
      code: string;
      state: string;
      teacherRole: string | null;
    }>(
      `SELECT c.code, c.state, t.pg_role AS "teacherRole"
         FROM class c JOIN app_user t ON t.id = c.teacher_id
        WHERE c.id = $1`,
      [classId],
    );
    const klass = classRows[0];
    if (!klass) throw new ServiceError('class_not_found', 'No such class.');
    if (klass.state !== 'active') {
      throw new ServiceError('class_archived', 'Cannot enrol into an archived class.');
    }

    // Fetched once and extended locally, so two "Muster Lena" in the same paste
    // get distinct names rather than colliding on the unique index.
    const taken = await takenIdentifiers(q);
    const created: (CreatedUser & { dbPassword: string })[] = [];

    for (const { person, displayName, locale, credential } of prepared) {
      const identifier = allocateIdentifier(
        studentIdentifier(klass.code, person.lastName, person.firstName),
        taken,
      );
      taken.add(identifier);

      const user = await insertUser(q, {
        identifier,
        displayName,
        locale,
        role: 'student',
        passwordHash: credential.passwordHash,
        dbPassword: credential.dbPassword,
        // Default false: the slip password *is* the credential in this design.
        // Making a fifteen-year-old invent one in the first five minutes of the
        // first lesson costs more than it buys.
        mustChangePassword: options.mustChangePassword ?? false,
        createdBy: actorId,
      });

      await q.query(
        `INSERT INTO class_member (class_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [classId, user.id],
      );
      await audit(q, {
        actorId,
        action: 'student_created',
        targetType: 'app_user',
        targetId: user.id,
        detail: { username: user.username, classId },
      });

      created.push({ user, password: credential.password, dbPassword: credential.dbPassword });
    }

    return { created, teacherRole: klass.teacherRole };
  });

  // Provisioning runs *outside* the transaction, deliberately. `q` above is a
  // pinned connection to the meta database; roles and schemas are created in
  // the teaching database through teachAdminPool. Two databases cannot share a
  // transaction, so doing it inside would be a dual write pretending to be
  // atomic: a meta COMMIT that failed after provisioning would leave orphan
  // roles — and an orphan role holds its name forever, because identifiers are
  // never re-issued. This way the worst case is an account with no schema yet,
  // which is visible in the roster and repaired by the reconciler.
  //
  // Sequentially, not Promise.all: each student is a short transaction in the
  // teaching database, and teachAdminPool holds five connections. A pasted
  // class of 25 firing at once would queue on the pool anyway, and would make
  // the audit trail of a partial failure much harder to read.
  const teacherRoles = teacherRole === null ? [] : [teacherRole];
  const results: CreatedUser[] = [];
  for (const { user, password, dbPassword } of created) {
    const pgRole = requirePgRole(user);
    const provisioning = await tryProvision(
      db,
      { actorId, userId: user.id, pgRole, step: 'ensureStudent' },
      () => prov.ensureStudent({ pgRole, pgPassword: dbPassword, canLogin: true, teacherRoles }),
    );
    // One student failing does not abandon the other 24: they are independent
    // roles, and the batch already committed.
    results.push({ user, password, provisioning });
  }

  return results;
}

// --- mutating ----------------------------------------------------------------

export interface StateChange {
  user: PublicUser;
  provisioning: ProvisionOutcome;
}

export async function setUserState(
  db: Db,
  prov: Provisioner,
  /**
   * Null for the nightly sweep, which nobody pressed — the same convention
   * `reconcile` uses, and the same reason: `audit_log.actor_id` is a foreign
   * key into `app_user`, so "the system did it" has to be the absence of an
   * actor rather than a sentinel id that references nothing.
   */
  actorId: number | null,
  userId: number,
  state: UserState,
  /**
   * How this transition came about, for the audit trail. The nightly sweep
   * passes 'sweep', which is what turns "why is Lena greyed out in my roster"
   * from a question into a query — architecture §8b wants archival never to be
   * silent, and this is the half of that a mail server would otherwise carry.
   */
  via?: 'sweep',
): Promise<StateChange> {
  // Read the Postgres identity *before* the transaction: on the way to
  // 'deleted' this is the last moment the class memberships still exist to
  // derive the teacher grants from, and on the way back to 'active' it is what
  // lets a missing role be recreated rather than merely re-enabled. Since 5b it
  // also carries the *previous* state and `archive_path`, which is what tells
  // `applyStateToPostgres` that "make this active" means a restore.
  const identity = await pgIdentity(db, userId);

  if (state === 'cold') {
    if (identity === undefined || identity.role !== 'student') {
      // No `restoreTeacher` exists, and inventing one for a playground schema
      // would be machinery for a case that cannot be the disk pressure cold
      // exists to relieve: teachers are a dozen accounts, students are three
      // hundred. Refused rather than quietly ignored, because an admin who
      // clicked it is entitled to know it did nothing.
      throw new ServiceError('cold_students_only', 'Only a student account can be put into cold storage.');
    }
  }

  if (state === 'archived' && identity?.archivePath != null) {
    // Keyed on the dump, not on `state === 'cold'`, and that distinction is a
    // bug that was found by review rather than by running it. Archived means
    // "NOLOGIN, schema kept, one click back"; an account whose schema is in a
    // file cannot honestly claim that. The obvious guard — refuse `cold ->
    // archived` — closes only the one-hop route, and the two-hop route is
    // reachable without anybody clicking it: a `cold -> active` whose restore
    // fails leaves the row saying *active* with the dump still named, and the
    // nightly sweep then archives it on its own, because a year-idle account is
    // exactly what the sweep is looking for. The row would then claim a schema
    // it has not got, and the reconciler would restore 50 MB at 03:40 to make
    // the claim true.
    //
    // The two honest exits from a named dump are 'active', which restores it,
    // and 'deleted', which drops the role and leaves the dump on disk.
    throw new ServiceError(
      'restore_first',
      'This account has work in cold storage. Reactivate it first, then archive it.',
    );
  }

  const user = await db.tx(async (q) => {
    const { rows } = await q.query<PublicUser>(
      // archived_at is cleared only on the way back to 'active'. Clearing it on
      // *every* other transition would wipe the timestamp when an already
      // archived account is later deleted — and that timestamp is what phase
      // 5's retention job keys off to decide what is safe to dump and drop.
      //
      // 'cold' takes `coalesce`, not `now()`: it is an archival event and wants
      // a timestamp, but an account that was archived in March and cooled in
      // July stopped being active in March, and that is the date worth keeping.
      //
      // `archive_path` is deliberately NOT written here. The dump happens after
      // this transaction commits, outside it, like all provisioning — so the
      // column is set only once a file exists, and never claims a backup that
      // does not (which is the mistake the old `not_implemented` guard existed
      // to prevent, kept rather than dropped).
      `UPDATE app_user
          SET state = $2::user_state,
              archived_at = CASE $2::user_state
                              WHEN 'archived' THEN now()
                              WHEN 'active'   THEN NULL
                              WHEN 'cold'     THEN coalesce(archived_at, now())
                              ELSE archived_at
                            END
        WHERE id = $1 AND role <> 'admin' AND state <> 'deleted'
        RETURNING ${USER_COLUMNS}`,
      [userId, state],
    );
    const user = rows[0];
    if (!user) {
      throw new ServiceError('user_not_found', 'No such account, or it is an admin.');
    }

    // Anything but 'active' must take effect immediately, not at next expiry.
    if (state !== 'active') await destroyUserSessions(q, userId);

    await audit(q, {
      actorId,
      action: 'user_state_changed',
      targetType: 'app_user',
      targetId: userId,
      detail: { state, username: user.username, ...(via === undefined ? {} : { via }) },
    });

    return user;
  });

  return { user, provisioning: await applyStateToPostgres(db, prov, actorId, identity, state) };
}

/**
 * Record where a dump landed, or that it is no longer needed.
 *
 * Outside the state transaction, and after the provisioning step, because that
 * is the only ordering in which the column cannot lie: it is written once a
 * file exists and cleared once its contents are back in the database. A failure
 * of *this* write leaves a path pointing at a real dump for an account that no
 * longer needs one, which the reconciler resolves harmlessly — the opposite,
 * clearing it before the restore lands, would orphan a term's work on disk with
 * nothing in the system that knows its name.
 */
export async function recordArchivePath(
  db: Db,
  userId: number,
  archivePath: string | null,
): Promise<void> {
  await db.query(`UPDATE app_user SET archive_path = $2 WHERE id = $1`, [userId, archivePath]);
}

/**
 * Make the teaching database match the account's new state (architecture §8b).
 *
 *   active   -> the role exists and can log in. A full `ensure`, not just
 *               `LOGIN`, so restoring an account whose role was never created
 *               (or was created and lost) actually restores it — and, since 5b,
 *               a `pg_restore` first if the account is coming back from cold.
 *   archived -> NOLOGIN. The schema and every table in it stay exactly as they
 *               were; this is reversible by design and must not destroy work.
 *   cold     -> dump the schema, drop the schema, keep the role NOLOGIN. The
 *               role is not the disk; see `coldStore`.
 *   deleted  -> dump to the archive, then drop schema and role — in that order,
 *               and the drop is skipped if the dump failed.
 *
 * A failure here leaves the account row in its new state with the teaching
 * database lagging. That asymmetry is chosen: for 'deleted' it means the work
 * still exists and the reconciler will retry the dump, which is the recoverable
 * direction. The opposite — dropping first and recording later — is not. 'cold'
 * inherits the same shape in both directions: a failed dump leaves an intact
 * schema behind a row that says cold, and a failed restore leaves the dump on
 * disk with `archive_path` still pointing at it, which is what lets
 * `reconcile.ts` finish the job on the next pass.
 */
async function applyStateToPostgres(
  db: Db,
  prov: Provisioner,
  actorId: number | null,
  identity: PgIdentity | undefined,
  state: UserState,
): Promise<ProvisionOutcome> {
  // Admins have no Postgres identity at all, and `setUserState` refuses them
  // anyway; nothing to do and nothing wrong.
  if (!identity) return PROVISION_OK;
  const { pgRole, pgPassword, teacherRoles, role, archivePath } = identity;

  if (state === 'deleted') {
    const outcome = await tryProvision(
      db,
      { actorId, userId: identity.userId, pgRole, step: 'archiveAndDrop' },
      () => prov.archiveAndDrop(pgRole),
    );
    if (outcome.ok) {
      // `?? archivePath`, not `?? null`: deleting an account that was already
      // cold produces no new dump, because there is no schema left to dump.
      // Overwriting the column with null there would throw away the name of the
      // only copy of that student's work that still exists.
      const path = outcome.archivePath ?? archivePath;
      if (path !== null) await recordArchivePath(db, identity.userId, path);
      await audit(db, {
        actorId,
        action: 'user_deprovisioned',
        targetType: 'app_user',
        targetId: identity.userId,
        detail: { pgRole, archivePath: path },
      });
    }
    return outcome;
  }

  if (state === 'cold') {
    const outcome = await tryProvision(
      db,
      { actorId, userId: identity.userId, pgRole, step: 'coldStore' },
      () => prov.coldStore(pgRole),
    );
    if (outcome.ok) {
      const path = outcome.archivePath ?? archivePath;
      if (path !== null) await recordArchivePath(db, identity.userId, path);
      await audit(db, {
        actorId,
        action: 'user_cold_stored',
        targetType: 'app_user',
        targetId: identity.userId,
        detail: { pgRole, archivePath: path },
      });
    }
    return outcome;
  }

  if (state === 'archived') {
    return tryProvision(
      db,
      { actorId, userId: identity.userId, pgRole, step: 'setLogin' },
      () => prov.setLogin(pgRole, false),
    );
  }

  // --- back to active ---------------------------------------------------------
  //
  // A dump path plus a student is an account whose schema is in cold storage —
  // either because it was put there, or because a previous restore failed
  // partway and left the row saying active. Both want the same thing, and it is
  // not `ensureStudent`: that would create an *empty* schema and leave the dump
  // on disk with nothing referring to it. This is the §4dd hazard in the one
  // place it is a deliberate transition rather than an accident.
  if (role === 'student' && archivePath !== null) {
    let tables = 0;
    const outcome = await tryProvision(
      db,
      { actorId, userId: identity.userId, pgRole, step: 'restoreStudent' },
      async () => {
        ({ tables } = await prov.restoreStudent({
          pgRole,
          pgPassword,
          canLogin: true,
          teacherRoles,
          archivePath,
        }));
      },
    );

    // Outside the callback, deliberately. Inside it, a dropped meta connection
    // on the `UPDATE` would be caught by `tryProvision` and reported as a
    // *restore* failure — over a restore that had in fact succeeded — leaving
    // `archive_path` set beside a schema that now exists. Nothing repairs that
    // pair: the reconciler's retry fires only for an account with no schema, so
    // `reportIsClean` would call the instance healthy while every future
    // reactivation died on `restoreStudent`'s "already exists" guard.
    //
    // Here the worst case is the honest one — a successful restore whose
    // bookkeeping did not land, which the next reconcile pass sees as a schema
    // that exists with a path still naming it, and which the operator can read
    // in the reconciler's `anomalies` list.
    if (outcome.ok) {
      // Only now: the tables are back and the student has been shown able to
      // read them. Until this line the dump is still the only copy.
      await recordArchivePath(db, identity.userId, null);
      await audit(db, {
        actorId,
        action: 'user_restored',
        targetType: 'app_user',
        targetId: identity.userId,
        detail: { pgRole, archivePath, tables },
      });
    }
    return outcome;
  }

  return tryProvision(
    db,
    { actorId, userId: identity.userId, pgRole, step: 'ensureActive' },
    () =>
      role === 'teacher'
        ? prov.ensureTeacher({ pgRole, pgPassword, canLogin: true })
        : prov.ensureStudent({ pgRole, pgPassword, canLogin: true, teacherRoles }),
  );
}

/**
 * "Wipe my database" — drop the student's schema and give them an empty one.
 *
 * Destructive and irreversible on purpose: students will wreck things, and
 * being able to start over without asking anyone is part of what makes the
 * sandbox safe to experiment in. There is no dump first — the schema is a
 * scratchpad, and taking a 50 MB archive every time a fifteen-year-old presses
 * "reset" would fill the disk with noise nobody will ever read.
 */
export async function resetStudentSchema(
  db: Db,
  prov: Provisioner,
  actorId: number,
  userId: number,
): Promise<ProvisionOutcome> {
  const identity = await pgIdentity(db, userId);
  if (!identity) throw new ServiceError('user_not_found', 'No such account.');
  if (identity.state !== 'active') {
    throw new ServiceError('user_not_active', 'Only an active account can be reset.');
  }

  const outcome = await tryProvision(
    db,
    { actorId, userId, pgRole: identity.pgRole, step: 'resetSchema' },
    () => prov.resetSchema(identity.pgRole, identity.teacherRoles),
  );

  if (outcome.ok) {
    await audit(db, {
      actorId,
      action: 'schema_reset',
      targetType: 'app_user',
      targetId: userId,
      detail: { pgRole: identity.pgRole },
    });
  }
  return outcome;
}

/**
 * Issue a fresh slip password. Returned once; it is not recoverable afterwards.
 *
 * Staff are forced to change it on next login, students are not — the same rule
 * as account creation, and for the same reason. Getting this wrong the other way
 * would be the worse bug: a teacher account, which can create and delete
 * students and read their credentials, left permanently on a ~22-bit password
 * that was read out over the phone.
 */
export async function resetPassword(db: Db, actorId: number, userId: number): Promise<CreatedUser> {
  const { password, passwordHash } = await prepareCredential();

  const user = await db.tx(async (q) => {
    const { rows } = await q.query<PublicUser>(
      `UPDATE app_user
          SET password_hash = $2,
              must_change_password = (role <> 'student')
        WHERE id = $1 AND state <> 'deleted'
        RETURNING ${USER_COLUMNS}`,
      [userId, passwordHash],
    );
    const updated = rows[0];
    if (!updated) throw new ServiceError('user_not_found', 'No such account.');

    // Whoever holds the old session should not outlive the old password.
    await destroyUserSessions(q, userId);
    await audit(q, {
      actorId,
      action: 'password_reset',
      targetType: 'app_user',
      targetId: userId,
      detail: { username: updated.username },
    });
    return updated;
  });

  return { user, password };
}

export const MIN_PASSWORD_LENGTH = 10;

export async function changeOwnPassword(
  db: Db,
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.normalize('NFKC').length < MIN_PASSWORD_LENGTH) {
    throw new ServiceError(
      'password_too_short',
      `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const { rows } = await db.query<{ passwordHash: string }>(
    `SELECT password_hash AS "passwordHash" FROM app_user WHERE id = $1 AND state = 'active'`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new ServiceError('user_not_found', 'No such account.');
  if (!(await verifyPassword(currentPassword, row.passwordHash))) {
    throw new ServiceError('wrong_password', 'The current password is not correct.');
  }
  if (await verifyPassword(newPassword, row.passwordHash)) {
    throw new ServiceError('password_unchanged', 'Choose a password you have not used here before.');
  }

  const newHash = await hashPassword(newPassword);

  await db.tx(async (q) => {
    // `state = 'active'` again, not just in the SELECT above: the two run on
    // different connections, so an admin can archive or delete the account in
    // between and we must not rotate the credential of a row that is on its way
    // out.
    const { rows: updated } = await q.query<{ id: number }>(
      `UPDATE app_user SET password_hash = $2, must_change_password = false
        WHERE id = $1 AND state = 'active'
        RETURNING id`,
      [userId, newHash],
    );
    if (updated.length === 0) throw new ServiceError('user_not_found', 'No such account.');
    // Log every other device out; the caller re-issues a session for this one.
    await destroyUserSessions(q, userId);
    await audit(q, {
      actorId: userId,
      action: 'password_changed',
      targetType: 'app_user',
      targetId: userId,
    });
  });
}

/**
 * The one mutating service that used to write no `audit_log` row.
 *
 * `display_name` is not cosmetic: it is the label the roster and the live
 * lesson view render, so a student who sets theirs to a classmate's name gives
 * a teacher two identical rows and attaches the classmate's name to their own
 * SQL history. Set it back afterwards and, without this, nothing anywhere
 * recorded that it had ever been anything else.
 *
 * `user_renamed` had been in `AuditAction` since the union was written, with no
 * emitter — which is what a dropped intention looks like rather than a decision.
 *
 * A `Db` rather than a `Queryable`, because the row and the change have to land
 * together: an audit trail that can be missing the row for the change it
 * describes is not one. A locale change alone does not get a row — it is a
 * preference, it is visible to nobody but its owner, and auditing it would bury
 * the renames in noise.
 */
export async function updateProfile(
  db: Db,
  userId: number,
  patch: { locale?: string; displayName?: string },
): Promise<PublicUser> {
  const locale = patch.locale === undefined ? null : checkLocale(patch.locale);
  const displayName = patch.displayName?.trim();
  if (displayName !== undefined && displayName === '') {
    throw new ServiceError('invalid_name', 'A display name cannot be empty.');
  }

  return db.tx(async (q) => {
    // Read the old name inside the transaction rather than before it, so the
    // `from` in the audit row is the value this update actually replaced.
    const before = await q.query<{ displayName: string }>(
      `SELECT display_name AS "displayName" FROM app_user WHERE id = $1 AND state = 'active'`,
      [userId],
    );
    const previous = before.rows[0]?.displayName;

    const { rows } = await q.query<PublicUser>(
      `UPDATE app_user
          SET locale = COALESCE($2, locale),
              display_name = COALESCE($3, display_name)
        WHERE id = $1 AND state = 'active'
        RETURNING ${USER_COLUMNS}`,
      [userId, locale, displayName ?? null],
    );
    const user = rows[0];
    if (!user) throw new ServiceError('user_not_found', 'No such account.');

    if (displayName !== undefined && displayName !== previous) {
      await audit(q, {
        actorId: userId,
        action: 'user_renamed',
        targetType: 'app_user',
        targetId: userId,
        detail: { from: previous ?? null, to: displayName },
      });
    }
    return user;
  });
}
