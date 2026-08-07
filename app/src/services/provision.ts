/**
 * The provisioning engine — phase 2.
 *
 * Everything that makes a row in `app_user` into a real Postgres identity:
 * the login role, the schema it owns, the teacher's read-only grant, the
 * session rails, the reset, the archive dump, the drop.
 *
 * Three properties this file is built around:
 *
 * **It is idempotent.** Every operation is "make the world look like this",
 * not "do this once". `app_user` carries no `provisioned_at` flag on purpose
 * (HANDOFF §7): Postgres is the source of truth for what exists, so a second
 * source that can disagree would be a bug generator. The consequence is that
 * `reconcile.ts` can run the same calls over accounts phase 1 already created,
 * and a run that dies halfway is repaired by the next one.
 *
 * **It never runs in the meta transaction.** Roles and schemas live in the
 * teaching database; accounts live in the meta database. Two databases cannot
 * share a transaction, so callers commit their meta work first and provision
 * afterwards. A crash in between leaves an account with no role — visible, and
 * repaired by the reconciler — rather than a role with no account, which is
 * invisible and holds a schema name hostage forever.
 *
 * **It builds SQL by string.** DDL takes no bind parameters. See db/ident.ts
 * for the allow-list and the quoting that keeps that honest.
 *
 * The SQL sequences come from ARCHITECTURE.md §2, which is verified against a
 * real server by db/verify-isolation.sh. Where this file goes beyond that
 * document, the comment says why.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import {
  assertPlainIdent,
  assertRoleName,
  assertWorkspaceSchema,
  quoteIdent,
  quoteLiteral,
} from '../db/ident.js';
import { dropUserPool, getUserPool } from '../db/pools.js';
import type { Db, Queryable } from '../db/query.js';
import { audit } from './audit.js';

const execFileAsync = promisify(execFile);

/** An account as the teaching database needs to see it. */
export interface RoleSpec {
  pgRole: string;
  /** Decrypted by the caller — `crypto/secretbox.ts` holds the ciphertext form. */
  pgPassword: string;
  /** `false` for archived accounts: the role and schema stay, the login does not. */
  canLogin: boolean;
}

export interface StudentSpec extends RoleSpec {
  /** Every teacher of every class this student is in. Usually one. */
  teacherRoles: string[];
}

export interface SchemaUsage {
  schema: string;
  bytes: number;
}

/** An account coming back from cold storage: `ensureStudent`, plus a dump. */
export interface RestoreSpec extends StudentSpec {
  archivePath: string;
}

/**
 * What a restore put back, and how much of it the student can actually reach.
 *
 * Two numbers rather than one because the failure this is here to catch makes
 * them differ: `tables` is counted as `dbk_app`, `readable` as the student. See
 * `restoreStudent`.
 */
export interface RestoreResult {
  tables: number;
  readable: number;
}

/** What actually exists right now, for the reconciler to diff against. */
export interface Inventory {
  /**
   * `canConnect` is not a property of the role at all — it lives in
   * `pg_database.datacl`, which is why it needs saying separately and why it
   * was missing here until a restore drill found it. Neither dump carries that
   * ACL back: `pg_dumpall --globals-only` covers roles and memberships, and a
   * `pg_restore` *into* an existing database never touches the database's own
   * privileges. So a restored cluster has every role, every schema and every
   * row, and not one student who can open a connection.
   */
  /**
   * `hasSettings` is whether the role still carries the `roleSettings` GUCs.
   *
   * A student may run `ALTER ROLE u_me RESET ALL` on their own role — all three
   * settings are USERSET, so Postgres permits it — and nothing ever put them
   * back: `roleSettings` is only issued from `ensureRole`, which the reconciler
   * reached only when the role or schema was *missing*. The rails silently
   * ceased to exist and no report said so.
   */
  roles: Map<string, { canLogin: boolean; canConnect: boolean; hasSettings: boolean }>;
  schemas: Set<string>;
  /** schema name -> roles holding USAGE on it, excluding the owner. */
  usageGrants: Map<string, Set<string>>;
}

export interface Provisioner {
  ensureTeacher(spec: RoleSpec): Promise<void>;
  ensureStudent(spec: StudentSpec): Promise<void>;
  grantTeacher(studentRole: string, teacherRole: string): Promise<void>;
  revokeTeacher(studentRole: string, teacherRole: string): Promise<void>;
  setLogin(pgRole: string, canLogin: boolean): Promise<void>;
  /**
   * Re-grant CONNECT on the teaching database. Its own seam rather than a
   * re-`ensure` for the same reason `setLogin` is: a narrow divergence gets a
   * narrow repair, and the reconciler's report then says what was actually
   * wrong instead of calling a restored cluster's every account "created".
   */
  grantConnect(pgRole: string): Promise<void>;
  /**
   * Re-issue the session rails (`statement_timeout`, the idle-transaction
   * timeout, `work_mem`) on a role that has lost them.
   *
   * Its own seam for the same reason `setLogin` and `grantConnect` are: a narrow
   * divergence deserves a narrow repair, so the reconciler's report can say
   * "settings restored" instead of calling the account "created".
   */
  applyRoleSettings(pgRole: string): Promise<void>;
  /** Wipe and recreate a schema, then put the teacher grants back. */
  resetSchema(studentRole: string, teacherRoles: string[]): Promise<void>;
  /**
   * An exercise workspace (phase 9): a second schema, owned by the same student,
   * holding one exercise's tables.
   *
   * Here rather than in `services/exercise.ts` because `CREATE SCHEMA ...
   * AUTHORIZATION` runs as `dbk_app`, which is precisely the hazard class this
   * file's header is about — and because the teacher grant on it needs `asRole`,
   * which is trap 2 and lives here.
   *
   * Idempotent like everything else here: creating one that exists re-applies
   * the grants and returns. That is what makes the student's "open this
   * exercise" a repair path as well as a first run.
   *
   * Reports whether it *made* the schema, because that is the one thing the
   * caller cannot ask again afterwards and the one thing it needs: an existing
   * workspace must not have the exercise's fixtures replayed into it, or every
   * visit would wipe the student's work. Returning it here rather than having
   * `exercise.ts` call `schemaExists` first keeps the answer inside the same
   * transaction as the decision it drives.
   */
  createWorkspace(
    studentRole: string,
    schema: string,
    teacherRoles: string[],
  ): Promise<{ created: boolean }>;
  /** Drop one exercise workspace, leaving the student's playground alone. */
  dropWorkspace(studentRole: string, schema: string): Promise<void>;
  /**
   * Schemas the student owns besides their playground.
   *
   * Read from `pg_namespace`, so it answers for a workspace whose meta row was
   * deleted as well as one still listed — which is the case the quota and the
   * cold-storage path have to get right.
   */
  listWorkspaces(studentRole: string): Promise<string[]>;
  /** Dump to the archive, then drop schema and role. Returns the dump path. */
  archiveAndDrop(pgRole: string): Promise<string | null>;
  /**
   * Cold storage (architecture §8b): dump the schema, drop the schema, keep the
   * role. Returns the dump path, or null if there was no schema to dump.
   *
   * The asymmetry with `archiveAndDrop` is the whole decision. Cold exists for
   * disk pressure, and the schema is the disk — a `pg_authid` row is not. So the
   * role stays, NOLOGIN, which is what keeps `cold -> active` an idempotent
   * `restoreStudent` with the same identifier, the same stored
   * `pg_password_enc` and no new credential slip. Dropping the role instead
   * would make cold indistinguishable from deleted inside Postgres while still
   * claiming to be reversible.
   */
  coldStore(pgRole: string): Promise<string | null>;
  /** Bring a cold account back: restore its dump, re-ensure it, and prove it. */
  restoreStudent(spec: RestoreSpec): Promise<RestoreResult>;
  /**
   * Bytes per student schema. With no argument, every schema in the instance —
   * which is a roster of every other teacher's students, and why
   * `/api/admin/usage` is admin-only. `only` narrows it to named schemas so a
   * caller scoped to one class never receives the rest (`services/lesson.ts`).
   */
  schemaUsage(only?: string[]): Promise<SchemaUsage[]>;
  inventory(names: string[]): Promise<Inventory>;
  /** True when this provisioner actually talks to Postgres. */
  readonly live: boolean;
}

/**
 * What a provisioning step did, reported back to the caller.
 *
 * The seams run *after* the meta transaction has committed, so by the time one
 * of them fails the account already exists and the response cannot honestly be
 * an error. It reports the account and this alongside it.
 *
 * `error` carries our own message — which can name a role or a schema. That is
 * a deliberate trade: these routes are admin/teacher-only, the names in them
 * are ones the staff member already sees in the roster, and a provisioning
 * failure that surfaces as a silent shrug during a lesson costs far more than
 * the disclosure. Raw driver errors are logged and audited, not returned.
 */
export interface ProvisionOutcome {
  ok: boolean;
  error?: string;
  /** Where a deletion's archive dump landed. */
  archivePath?: string;
}

export const PROVISION_OK: ProvisionOutcome = { ok: true };

/**
 * Run one provisioning step and record a failure rather than throwing it.
 *
 * Nothing here is allowed to take down a request that has already committed.
 * The audit row is what makes the failure recoverable: `reconcile.ts` finds the
 * same gap by comparing `app_user` against `pg_roles`, and the row tells whoever
 * is reading the log *why* it was left behind.
 */
export async function tryProvision(
  db: Queryable,
  entry: { actorId: number | null; userId?: number; pgRole: string; step: string },
  fn: () => Promise<string | null | void>,
): Promise<ProvisionOutcome> {
  try {
    const archivePath = await fn();
    return archivePath ? { ok: true, archivePath } : PROVISION_OK;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[provision] ${entry.step} failed for ${entry.pgRole}: ${message}`);
    // A failure to *log* the failure must not replace it with a different one.
    await audit(db, {
      actorId: entry.actorId,
      action: 'provision_failed',
      targetType: 'app_user',
      ...(entry.userId === undefined ? {} : { targetId: entry.userId }),
      detail: { pgRole: entry.pgRole, step: entry.step, error: message },
    }).catch((auditErr: unknown) => {
      console.error('[provision] could not write the audit row:', auditErr);
    });
    return { ok: false, error: message };
  }
}

// --- statement builders ------------------------------------------------------
//
// Separated from the execution so the live test can assert on the text, and so
// a reader can compare them against ARCHITECTURE.md §2 line by line.

const TEACH_DB = quoteIdent(assertPlainIdent(config.pg.teachDb));
const APP_USER = quoteIdent(assertPlainIdent(config.pg.user));

/**
 * Session defaults applied to every provisioned role.
 *
 * `statement_timeout` is here to stop the accidental cartesian join without a
 * round trip to the app. It is NOT a boundary — it is `USERSET`, so a student
 * can raise it on their own role and Postgres offers no way to forbid that
 * (ARCHITECTURE.md §3). The watchdog in phase 3 is the actual control.
 *
 * **`work_mem` is USERSET too, and for a long time this comment did not say so
 * — it sorted the other two settings into the right buckets and left the third
 * looking like a limit.** `SET work_mem = '6GB'` escapes it, `hash_mem_multiplier`
 * multiplies it, and it is charged per sort/hash node per parallel worker, so a
 * single statement can ask for many times the number. The control is the
 * `mem_limit` on the db container in docker-compose.yml, not this line; what
 * this line buys is a sane default for students who never think about it.
 *
 * `temp_file_limit` is deliberately absent: it is `SUSET`, so `dbk_app` cannot
 * set it per role at all. It is set cluster-wide in docker-compose.yml, where
 * a student cannot reach it. Note it caps spill to disk only — it is not a
 * second line of defence for the above.
 */
function roleSettings(role: string): string[] {
  const r = quoteIdent(role);
  return [
    `ALTER ROLE ${r} SET statement_timeout = ${quoteLiteral(config.limits.statementTimeout)}`,
    `ALTER ROLE ${r} SET idle_in_transaction_session_timeout = ${quoteLiteral(
      config.limits.idleInTransactionTimeout,
    )}`,
    `ALTER ROLE ${r} SET work_mem = ${quoteLiteral(config.limits.workMem)}`,
  ];
}

function createRoleSql(spec: RoleSpec): string {
  const r = quoteIdent(spec.pgRole);
  return (
    `CREATE ROLE ${r} ${spec.canLogin ? 'LOGIN' : 'NOLOGIN'} ` +
    `PASSWORD ${quoteLiteral(spec.pgPassword)} ` +
    `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS ` +
    `CONNECTION LIMIT ${config.limits.roleConnectionLimit}`
  );
}

/**
 * The non-obvious one (trap 1 of three, HANDOFF §4a).
 *
 * `CREATEROLE` gives `dbk_app` `admin_option` on the roles it creates but not
 * `set_option`, and `CREATE SCHEMA ... AUTHORIZATION` requires the ability to
 * SET ROLE to the target. Without this the very next statement fails with
 * "must be able to SET ROLE".
 *
 * `INHERIT FALSE` stays: `dbk_app` must never pick up a student's privileges
 * by accident, only by stepping into the role deliberately.
 */
function grantRoleToAppSql(role: string): string {
  return `GRANT ${quoteIdent(role)} TO ${APP_USER} WITH INHERIT FALSE, SET TRUE`;
}

/**
 * The teacher's read-only view of a schema the student owns.
 *
 * `schema` rather than `studentRole` since phase 9: a student now owns their
 * playground schema *and* one schema per exercise they have opened, and the
 * teacher needs the same read on both. Every statement below only ever named the
 * schema; the parameter was called `studentRole` because until phase 9 the two
 * were the same string. The caller still supplies the role — it is what `asRole`
 * needs, and it is the reason these statements work at all (trap 2 below).
 *
 * Must be issued *by the student* (trap 2): `dbk_app` holds NOINHERIT
 * membership, so it has no privileges on the schema it just created until it
 * steps into the role.
 *
 * Two lines here that ARCHITECTURE.md §2 does not have, because §2 describes
 * provisioning a fresh schema and this also has to work on a full one:
 *
 *   - `ON ALL TABLES` covers what the student has *already* created. A teacher
 *     added to a class in week six, or reassigned a class, would otherwise see
 *     nothing that existed before the grant.
 *   - `ALTER DEFAULT PRIVILEGES` covers what they create next. Without it the
 *     teacher's view silently stops at the tables that existed today — the
 *     mistake §2 already warns about.
 *
 * Sequences as well as tables, so `SELECT * FROM kunden_id_seq` and the
 * schema browser's row-count queries do not produce a permission error the
 * teacher cannot explain.
 */
function grantTeacherSql(schema: string, teacherRole: string): string[] {
  const s = quoteIdent(schema);
  const t = quoteIdent(teacherRole);
  return [
    // --- the confused deputy, narrowed (NOT closed — read on) ---------------
    //
    // Not about this teacher. Three correct behaviours compose into an
    // exfiltration path:
    //
    //   1. `ON TABLES` below covers *views* as well as tables, so a view the
    //      student creates later is readable by their teacher automatically.
    //   2. A view resolves table access with the **view owner's** rights, but a
    //      function called inside it defaults to `SECURITY INVOKER` — so it
    //      runs as whoever selected from the view.
    //   3. `EXECUTE` on a new function is granted to `PUBLIC` by default.
    //
    // So `CREATE VIEW kunden AS SELECT beute()`, where `beute()` inserts from a
    // classmate's schema into the student's own table, hands that classmate's
    // rows over the moment the teacher reads the view — the ordinary lesson
    // workflow, not an unlikely slip. Demonstrated end to end against a real
    // cluster; the payload observed `current_user` = the teacher's role.
    //
    // `ROUTINES` rather than `FUNCTIONS`: the spelling that also covers
    // procedures.
    //
    // **This only covers routines that exist right now.** The obvious companion
    // — `ALTER DEFAULT PRIVILEGES IN SCHEMA s REVOKE EXECUTE ON ROUTINES FROM
    // PUBLIC` — was here and has been removed because *it does not work*, which
    // is worth knowing before someone adds it back. Measured on PostgreSQL 18:
    // the statement is accepted, and either records nothing in `pg_default_acl`
    // or records an entry without PUBLIC — and a function created afterwards
    // still comes out with `proacl = NULL`, i.e. `EXECUTE` to PUBLIC, because
    // the built-in `acldefault()` is unioned back in. A teacher could still
    // execute it. A line that looks like a control and is not one is worse than
    // no line, so the comment stays and the statement does not.
    //
    // What remains open: a routine the student creates *after* provisioning.
    // Closing that needs an event trigger (superuser, so it belongs in
    // db/init/00-bootstrap.sh plus a one-off statement on the live cluster) or
    // a periodic re-issue of this REVOKE. `reconcile` is not a home for it as
    // things stand — it runs at boot and on demand, not on a schedule. The
    // second layer meanwhile is in the browser: `web/assets/sql.js` no longer
    // auto-runs a relation in a schema the caller does not own.
    //
    // Teacher-independent, so with two teachers this runs twice. It is
    // idempotent, and the alternative — a second `asRole` round trip on a
    // different code path — is how it ends up not running at all.
    //
    // Deliberately **not** undone in `revokeTeacherSql`: re-granting EXECUTE to
    // PUBLIC when a teacher stops teaching would reopen this for the next one.
    `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA ${s} FROM PUBLIC`,

    `GRANT USAGE ON SCHEMA ${s} TO ${t}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${t}`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${t}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT ON TABLES TO ${t}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT ON SEQUENCES TO ${t}`,
  ];
}

/**
 * The token a GRANT/REVOKE needs for this grantee.
 *
 * `PUBLIC` is a keyword, not an identifier: `REVOKE ... FROM "PUBLIC"` looks for
 * a role of that name and errors. Everything else goes through `assertRoleName`
 * first, exactly as before — the sentinel is the only bypass and it is a
 * compile-time constant, not anything a caller can steer.
 */
export const PUBLIC_GRANTEE = 'PUBLIC';
const granteeToken = (grantee: string): string =>
  grantee === PUBLIC_GRANTEE ? 'PUBLIC' : quoteIdent(assertRoleName(grantee));

/**
 * Undo of the above, in reverse order.
 *
 * The `ALTER DEFAULT PRIVILEGES` revokes come first and matter most: they are
 * the ones that would otherwise keep re-granting SELECT on every table the
 * student creates *after* the teacher stopped teaching them.
 *
 * Also the path that takes back a `GRANT ... TO PUBLIC` a student issued on
 * their own schema — see `inventory`, which can finally see one.
 */
function revokeTeacherSql(schema: string, teacherRole: string): string[] {
  const s = quoteIdent(schema);
  const t = granteeToken(teacherRole);
  return [
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE SELECT ON TABLES FROM ${t}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE SELECT ON SEQUENCES FROM ${t}`,
    `REVOKE SELECT ON ALL TABLES IN SCHEMA ${s} FROM ${t}`,
    `REVOKE SELECT ON ALL SEQUENCES IN SCHEMA ${s} FROM ${t}`,
    `REVOKE USAGE ON SCHEMA ${s} FROM ${t}`,
  ];
}

// --- helpers -----------------------------------------------------------------

/**
 * Run `fn` with the connection's role set to `role`, and put it back.
 *
 * `RESET ROLE` is not optional even though every caller is inside a
 * transaction that would roll it back on failure: on the *success* path the
 * connection goes back to the pool, and node-postgres does not issue
 * `DISCARD ALL` on release. A leaked `SET ROLE` would hand the next
 * provisioning call a connection acting as some student.
 */
async function asRole<T>(q: Queryable, role: string, fn: () => Promise<T>): Promise<T> {
  await q.query(`SET ROLE ${quoteIdent(assertRoleName(role))}`);
  try {
    return await fn();
  } finally {
    await q.query('RESET ROLE');
  }
}

async function execAll(q: Queryable, statements: string[]): Promise<void> {
  for (const sql of statements) await q.query(sql);
}

async function roleExists(q: Queryable, role: string): Promise<boolean> {
  const { rows } = await q.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
  return rows.length > 0;
}

async function schemaExists(q: Queryable, schema: string): Promise<boolean> {
  const { rows } = await q.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema]);
  return rows.length > 0;
}

/**
 * Every schema this role owns *other than* their playground — phase 9.
 *
 * Asked of `pg_namespace` rather than read from `exercise_workspace` in the meta
 * database, and that is the §3 rule rather than convenience. Postgres is the
 * source of truth for what exists, and the callers below are the ones where
 * being wrong is expensive: `coldStore` has to drop everything the role owns or
 * it does not reclaim the disk it exists to reclaim, and a later `DROP ROLE`
 * fails on whatever it missed. A meta-side list can drift; this cannot.
 *
 * It is deliberately not filtered to `^x[0-9]+_`. If some future schema ends up
 * owned by a student, the answer for both callers is still "it is theirs, and it
 * goes with them" — a filter here would silently exempt exactly the object
 * nobody remembered to think about.
 */
async function ownedSchemas(q: Queryable, role: string): Promise<string[]> {
  const { rows } = await q.query<{ nspname: string }>(
    `SELECT n.nspname
       FROM pg_namespace n
       JOIN pg_roles r ON r.oid = n.nspowner
      WHERE r.rolname = $1 AND n.nspname <> $1
      ORDER BY n.nspname`,
    [role],
  );
  return rows.map((r) => r.nspname);
}

// --- the live provisioner ----------------------------------------------------

export function makeProvisioner(teachDb: Db): Provisioner {
  /**
   * Create the role and the schema it owns, or bring an existing pair back
   * into line. One transaction: DDL is transactional in Postgres, so a failure
   * anywhere leaves no half-provisioned role behind.
   */
  async function ensureRole(spec: RoleSpec, q: Queryable): Promise<void> {
    assertRoleName(spec.pgRole);
    const r = quoteIdent(spec.pgRole);

    // NOTE: the two statements below are the only ones in the app carrying a
    // cleartext password in their *statement text*, and Postgres does not redact
    // that when it logs it. With `log_min_duration_statement=2000` in
    // docker-compose.yml, a `CREATE ROLE` slow enough to be logged would write a
    // student's database password to the container log in the clear.
    //
    // **It cannot be suppressed from here.** `SET LOCAL
    // log_min_duration_statement = -1` was tried and is rejected with
    // `permission denied to set parameter` — the GUC is SUSET and `dbk_app` is
    // deliberately not a superuser. Only a superuser could turn it off, and the
    // only role-scoped form (`ALTER ROLE dbk_app SET ...`) would disable slow
    // -query logging for every statement the app makes, which is a diagnostic
    // worth more than this is worth.
    //
    // Accepted, not overlooked: these are `CREATE ROLE`/`ALTER ROLE` on a
    // catalog table, so reaching two seconds takes a pathological stall, and the
    // log is root-readable on the host. See docs/HANDOFF.md.
    if (await roleExists(q, spec.pgRole)) {
      // Repair path. The password is reset from the encrypted store rather than
      // left alone: `pg_password_enc` is what the app will present on the
      // student's next query, so if the two ever diverge the store wins.
      await q.query(
        `ALTER ROLE ${r} ${spec.canLogin ? 'LOGIN' : 'NOLOGIN'} ` +
          `PASSWORD ${quoteLiteral(spec.pgPassword)} ` +
          `CONNECTION LIMIT ${config.limits.roleConnectionLimit}`,
      );
    } else {
      await q.query(createRoleSql(spec));
    }

    await q.query(grantRoleToAppSql(spec.pgRole));

    if (!(await schemaExists(q, spec.pgRole))) {
      await q.query(`CREATE SCHEMA ${r} AUTHORIZATION ${r}`);
    }

    await q.query(`GRANT CONNECT ON DATABASE ${TEACH_DB} TO ${r}`);
    await execAll(q, roleSettings(spec.pgRole));
  }

  /**
   * A named function rather than only a method, because `restoreStudent` calls
   * it too: coming back from cold storage is a `pg_restore` followed by exactly
   * this, and routing that through `this` inside an object literal would make
   * the dependency invisible to a reader of either one.
   */
  async function ensureStudentRole(spec: StudentSpec): Promise<void> {
    spec.teacherRoles.forEach(assertRoleName);
    await teachDb.tx(async (q) => {
      await ensureRole(spec, q);
      // Inside the same transaction as the schema creation, so a student can
      // never be visible to their teacher only after a second call succeeds.
      for (const teacher of spec.teacherRoles) {
        if (!(await roleExists(q, teacher))) continue; // reconciler will fill it in
        await asRole(q, spec.pgRole, () => execAll(q, grantTeacherSql(spec.pgRole, teacher)));
      }
    });
  }

  return {
    live: true,

    /** A teacher gets a role and a playground schema — but no grants on it to anyone. */
    async ensureTeacher(spec) {
      await teachDb.tx((q) => ensureRole(spec, q));
    },

    ensureStudent: ensureStudentRole,

    async grantTeacher(studentRole, teacherRole) {
      assertRoleName(studentRole);
      assertRoleName(teacherRole);
      await teachDb.tx(async (q) => {
        if (!(await schemaExists(q, studentRole)) || !(await roleExists(q, teacherRole))) return;
        await asRole(q, studentRole, () => execAll(q, grantTeacherSql(studentRole, teacherRole)));
      });
    },

    async revokeTeacher(studentRole, teacherRole) {
      assertRoleName(studentRole);
      // PUBLIC is a keyword rather than a role, so it has neither a name to
      // validate nor a row in `pg_roles` to look for. `granteeToken` is what
      // keeps the two apart; every other grantee is checked exactly as before.
      const isPublic = teacherRole === PUBLIC_GRANTEE;
      if (!isPublic) assertRoleName(teacherRole);
      await teachDb.tx(async (q) => {
        if (!(await schemaExists(q, studentRole))) return;
        if (!isPublic && !(await roleExists(q, teacherRole))) return;
        await asRole(q, studentRole, () => execAll(q, revokeTeacherSql(studentRole, teacherRole)));
      });
    },

    async applyRoleSettings(pgRole) {
      assertRoleName(pgRole);
      await teachDb.tx((q) => execAll(q, roleSettings(pgRole)));
    },

    async setLogin(pgRole, canLogin) {
      assertRoleName(pgRole);
      await teachDb.query(
        `ALTER ROLE ${quoteIdent(pgRole)} ${canLogin ? 'LOGIN' : 'NOLOGIN'}`,
      );
      // NOLOGIN stops the *next* connection, not the ones already open. An
      // archived student with a live pool would keep working until it idled out.
      if (!canLogin) await dropUserPool(pgRole);
    },

    async grantConnect(pgRole) {
      assertRoleName(pgRole);
      await teachDb.query(`GRANT CONNECT ON DATABASE ${TEACH_DB} TO ${quoteIdent(pgRole)}`);
      // No pool to drop: this repairs a role that could not connect, so there
      // cannot be a cached pool holding a connection it was never granted.
    },

    /**
     * "Wipe my database" — architecture §4.
     *
     * `DROP SCHEMA` takes the teacher's grants and default privileges with it,
     * because both are properties of the schema and its objects. ARCHITECTURE.md
     * §2 shows the drop-and-recreate without that step; leaving it out is how a
     * teacher silently loses sight of a class one reset at a time.
     */
    async resetSchema(studentRole, teacherRoles) {
      assertRoleName(studentRole);
      teacherRoles.forEach(assertRoleName);
      const s = quoteIdent(studentRole);

      await teachDb.tx(async (q) => {
        await asRole(q, studentRole, async () => {
          await q.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
          // `DROP SCHEMA ... CASCADE` does **not** take large objects with it —
          // they are not in any schema. Without this, "Datenbank zurücksetzen"
          // left every large object the student had created, still counted
          // against their quota (see `schemaUsage`) and with nothing left in
          // the schema to explain the number. `DROP OWNED BY` is the statement
          // that reaches them, and running it as the student scopes it to
          // exactly what they own.
          //
          // Since phase 9 it also reaches their exercise workspaces, and that is
          // the right answer for a button labelled "wipe my whole database" —
          // but only because a workspace comes back: the student opening the
          // exercise again re-materialises it from the exercise definition. The
          // per-exercise reset is `dropWorkspace`, which is narrow.
          await q.query(`DROP OWNED BY CURRENT_USER CASCADE`);
        });
        await q.query(`CREATE SCHEMA ${s} AUTHORIZATION ${s}`);
        for (const teacher of teacherRoles) {
          if (!(await roleExists(q, teacher))) continue;
          await asRole(q, studentRole, () => execAll(q, grantTeacherSql(studentRole, teacher)));
        }
      });

      // Their open connections still hold the old search_path resolution and,
      // worse, may sit in a transaction against tables that no longer exist.
      await dropUserPool(studentRole);
    },

    /**
     * One exercise's schema, owned by the student — phase 9.
     *
     * The same two statements `ensureRole` uses for a playground schema, and
     * deliberately so: the isolation story for an exercise is not a new one, it
     * is the existing one applied a second time. What is *not* copied is
     * `GRANT CONNECT` and the role settings, which are properties of the role
     * and are already in place by the time anyone can reach this.
     *
     * A workspace name and a role name cannot be confused — `db/ident.ts` keeps
     * the two allow-lists disjoint — so the assert below is `assertWorkspaceSchema`
     * and would reject `u_k3a_muster_lena` as loudly as it rejects `pg_catalog`.
     */
    async createWorkspace(studentRole, schema, teacherRoles) {
      assertRoleName(studentRole);
      assertWorkspaceSchema(schema);
      teacherRoles.forEach(assertRoleName);
      const s = quoteIdent(schema);

      return teachDb.tx(async (q) => {
        const created = !(await schemaExists(q, schema));
        if (created) {
          await q.query(`CREATE SCHEMA ${s} AUTHORIZATION ${quoteIdent(studentRole)}`);
        }
        // Re-applied even when the schema already existed. A teacher added to
        // the class in week six sees the exercise workspaces of students who
        // opened them in week one only because this runs every time.
        for (const teacher of teacherRoles) {
          if (!(await roleExists(q, teacher))) continue;
          await asRole(q, studentRole, () => execAll(q, grantTeacherSql(schema, teacher)));
        }
        return { created };
      });
    },

    /**
     * "Reset this exercise", and the drop half of taking one back.
     *
     * `DROP SCHEMA` and **not** `DROP OWNED BY CURRENT_USER`, which is what
     * `resetSchema` uses one function up: the wide form would take the student's
     * playground and every other exercise with it. The whole reason a workspace
     * is its own schema is that this line can be narrow.
     */
    async dropWorkspace(studentRole, schema) {
      assertRoleName(studentRole);
      assertWorkspaceSchema(schema);
      await teachDb.tx((q) =>
        asRole(q, studentRole, () => q.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)),
      );
      // Same reason as `resetSchema`: an open connection may be sitting in a
      // transaction against tables that no longer exist.
      await dropUserPool(studentRole);
    },

    async listWorkspaces(studentRole) {
      assertRoleName(studentRole);
      return ownedSchemas(teachDb, studentRole);
    },

    /**
     * Dump, then drop. In that order, and the drop does not run if the dump
     * failed — a deletion that loses a term's work because the archive
     * directory was not mounted is the one failure here that cannot be undone.
     */
    async archiveAndDrop(pgRole) {
      assertRoleName(pgRole);
      const r = quoteIdent(pgRole);

      // Stop new sessions before dumping, so the dump is not racing the student.
      const exists = await teachDb.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [pgRole]);
      if (exists.rows.length === 0) return null;
      await teachDb.query(`ALTER ROLE ${r} NOLOGIN`);
      await dropUserPool(pgRole);

      const hasSchema = await teachDb.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [
        pgRole,
      ]);
      const dumpPath = hasSchema.rows.length > 0 ? await dumpSchema(pgRole) : null;

      await teachDb.tx(async (q) => {
        await asRole(q, pgRole, async () => {
          // Wide on purpose, and since phase 9 that width is load-bearing rather
          // than merely thorough: this reaches the student's exercise workspaces
          // as well as their playground, which is what lets the `DROP ROLE`
          // below succeed. `coldStore` uses a narrow `DROP SCHEMA` and has to
          // sweep them by hand for exactly this reason.
          await q.query('DROP OWNED BY CURRENT_USER CASCADE');
        });
        // Trap 3: DROP OWNED BY covers objects *in* the database but not grants
        // *on* it, so DROP ROLE would fail with "privileges for database
        // datebaenkli". REASSIGN OWNED BY is not usable — it needs the
        // privileges of the role, which NOINHERIT membership does not confer.
        await q.query(`REVOKE ALL ON DATABASE ${TEACH_DB} FROM ${r}`);
        await q.query(`DROP ROLE ${r}`);
      });

      return dumpPath;
    },

    /**
     * Cold storage. Dump, drop the schema, keep the role.
     *
     * Same dump-before-drop discipline as `archiveAndDrop` and for the same
     * reason, but a narrower drop: `DROP SCHEMA ... CASCADE` as the owner rather
     * than `DROP OWNED BY CURRENT_USER`. The wider one would also strip the
     * privileges the role holds *elsewhere* in the database, and cold is
     * supposed to leave an account that is one restore from working — including
     * its `CONNECT` grant, which §4dd is the story of losing.
     *
     * NOLOGIN first, so the dump is not racing a student mid-`INSERT`.
     */
    async coldStore(pgRole) {
      assertRoleName(pgRole);
      const r = quoteIdent(pgRole);

      if (!(await roleExists(teachDb, pgRole))) {
        // Not `return null`. An account whose provisioning never landed has a
        // schema nobody has seen and a dump nobody can take, and reporting that
        // as a successful cold-store would write `user_cold_stored` with a null
        // path, tell the admin `provisioning.ok`, and pin the reconciler into
        // failing on this account on every pass forever with the advice
        // "reactivate it to restore the dump" — there being no dump.
        throw new Error(
          `${pgRole} has no Postgres role, so there is nothing to dump. ` +
            `Reconcile it back into existence before putting it into cold storage.`,
        );
      }
      await teachDb.query(`ALTER ROLE ${r} NOLOGIN`);
      await dropUserPool(pgRole);

      // --- exercise workspaces (phase 9) --------------------------------------
      //
      // **Read the placement, not the loop.** On the ordinary path this is
      // redundant: the `DROP OWNED BY CURRENT_USER CASCADE` at the bottom of
      // this function — which is there for large objects — already drops every
      // schema the role owns, workspaces included. That was verified against a
      // real cluster rather than assumed, by deleting this loop and watching
      // the workspaces disappear anyway.
      //
      // What it is actually for is the **early return three lines down**. An
      // account whose playground is already gone never reaches the bottom of
      // this function, and it can still own workspaces: `restoreStudent`'s
      // failure path drops the playground by name and leaves them, which is
      // precisely the cold-shaped state §4ff says a failed restore must be left
      // in. Cooling that account again would return `null` over a role still
      // holding schemas — disk that cold storage was called to reclaim, that
      // `schemaUsage` keeps reporting for an account with no login, and that
      // makes the eventual `DROP ROLE` fail months later with nothing to
      // explain it.
      //
      // So this is a narrow repair for a narrow state, and the comment says so
      // rather than claiming to be the control. An earlier draft of it claimed
      // the wide drop below did not reach these at all; it does, and a line that
      // looks like a control and is not one is worse than no line.
      //
      // **Dropped without being dumped, deliberately.** `dumpSchema` takes one
      // `-n`, so dumping these would mean a file per workspace and a restore
      // path per file; and unlike a playground, a workspace holds no work that
      // only exists here — its tables come from the exercise definition, which
      // is a row in the meta database, so a restored student gets them back by
      // opening the exercise. What is lost is what they typed *into* those
      // tables during the exercise, and cold storage already trades that class
      // of thing for disk.
      for (const workspace of await ownedSchemas(teachDb, pgRole)) {
        await teachDb.tx((q) =>
          asRole(q, pgRole, () =>
            q.query(`DROP SCHEMA IF EXISTS ${quoteIdent(assertWorkspaceSchema(workspace))} CASCADE`),
          ),
        );
      }

      // Already cold, or never had a schema. Idempotent like everything else
      // here: re-cooling a cold account is a no-op, not a second empty dump
      // that would overwrite `archive_path` with a worthless file.
      if (!(await schemaExists(teachDb, pgRole))) return null;

      const dumpPath = await dumpSchema(pgRole);

      await teachDb.tx(async (q) => {
        await asRole(q, pgRole, async () => {
          await q.query(`DROP SCHEMA ${r} CASCADE`);
          // Large objects are not in any schema, so CASCADE does not reach
          // them and neither does `dumpSchema` — and cold storage exists to
          // reclaim disk, which it cannot do while leaving gigabytes behind
          // that no report can attribute (after this, the schema is gone and
          // `schemaUsage` keys on schema name, so they become invisible too).
          //
          // **This drops them without dumping them, and that is a real trade.**
          // The alternative was `pg_dump -b`, which is worse and was measured:
          // large objects have no schema, so `--schema=X -b` dumps *every*
          // large object in the database — one student's data would land in
          // another's archive file and be recreated on their restore. Losing an
          // undumped object beats leaking one.
          //
          // Not a new policy either: `archiveAndDrop` has always done exactly
          // this on deletion, for the same reason. Nothing in the app can
          // create a large object — it takes hand-typed `lo_from_bytea` in the
          // editor — so the realistic case is an abuse or an accident, not a
          // lesson someone loses.
          await q.query(`DROP OWNED BY CURRENT_USER CASCADE`);
        });
      });

      return dumpPath;
    },

    /**
     * `cold -> active`: put the schema back, and prove the student can read it.
     *
     * **`--role`, and the schema created before the restore rather than by it.**
     * The obvious design is the mirror of `dumpSchema`: run as `dbk_app` and let
     * the dump's own `CREATE SCHEMA` and `ALTER ... OWNER TO` do the work. It
     * fails, and the way it fails is §4a in its fifth disguise. `dbk_app`
     * creates the schema, the dump's next statement hands ownership to the
     * student, and from that moment `dbk_app` — which holds the student's role
     * NOINHERIT — has no `CREATE` on the schema it just gave away. The very next
     * `CREATE TABLE` is `permission denied for schema u_…`. Whenever `dbk_app`
     * acts *on* a student's objects, check which of the two it is acting as.
     *
     * So the restore runs `--role`, like the dump. That costs one thing: a
     * student role is `NOCREATEDB NOCREATEROLE` and never holds `CREATE ON
     * DATABASE` — `ensureRole` creates their schema *for* them with
     * `CREATE SCHEMA ... AUTHORIZATION` — so `SET ROLE u_x` cannot execute the
     * dump's `CREATE SCHEMA` either. Hence the shape below: `ensureStudent`
     * makes the schema first, and the dump's own schema entry is filtered out of
     * the restore through a table-of-contents list file. Granting the student
     * `CREATE ON DATABASE` for the duration was the alternative and was
     * rejected: it opens a window in which a student can own a second schema,
     * and a crash mid-restore leaves that window open with nothing watching it.
     *
     * `--no-owner` then costs nothing and removes a class of failure: with
     * `--role` every object is created *by* the student, so ownership is right
     * by construction and no `ALTER ... OWNER` statement has to succeed.
     *
     * **`--no-privileges` is deliberate.** A year-old dump carries the GRANTs
     * the schema had when it was cooled, including USAGE to a teacher who may no
     * longer teach this student. The roster is the source of truth for who may
     * read a schema, so the ACLs are dropped and the second `ensureStudent`
     * below applies the current ones. Without it, restoring an account would
     * silently re-grant a former teacher access until the next reconcile pass.
     *
     * **The verification is the point of the method** (§4dd). `pg_restore`
     * exiting 0 proves statements ran, not that the student who owns the tables
     * can read them — that gap is exactly what let a restored cluster report
     * success over a class that could not connect. So the tables are counted
     * three ways that can only agree if everything worked: from the dump's own
     * table of contents, from `pg_class` as `dbk_app`, and from
     * `information_schema.tables` over a connection opened **as the student**,
     * which is privilege-filtered and therefore returns only what they can
     * actually reach. (§4o is where that filtering was first met, as a bug;
     * here it is the instrument.)
     */
    async restoreStudent(spec) {
      assertRoleName(spec.pgRole);
      spec.teacherRoles.forEach(assertRoleName);
      const { pgRole } = spec;

      // The path comes out of `app_user.archive_path`, which this app wrote —
      // but it is still a filesystem path from a database row handed to a
      // process that runs as `dbk_app`, so it is confined to the archive
      // directory here rather than trusted. `resolve` collapses any `..` first.
      const root = resolve(config.paths.archive);
      const target = resolve(spec.archivePath);
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error(`archive path is outside ${root}: ${spec.archivePath}`);
      }
      // Stat before shelling out, so "the dump is gone" is that sentence rather
      // than whatever pg_restore says about a file it could not open.
      await stat(target).catch(() => {
        throw new Error(`archive dump is missing, refusing to restore: ${target}`);
      });

      if (await schemaExists(teachDb, pgRole)) {
        // Checked before anything is created, because after `ensureStudent`
        // below the schema always exists and this question can no longer be
        // asked. Restoring over a schema that already holds work is not a
        // decision to make silently.
        throw new Error(
          `schema ${pgRole} already exists; a cold account should not have one. ` +
            `Reconcile reports this as an anomaly — resolve it by hand before restoring.`,
        );
      }

      // Everything from here on can create a schema, and every failure past this
      // point has to put the account back the way it was found — see the catch.
      let releaseList = async (): Promise<void> => {};
      try {
        // The role's session rails, CONNECT, and the schema the restore needs to
        // exist because `--role` cannot create it. **LOGIN unconditionally**,
        // whatever `spec.canLogin` asks for, and that is not a slip: the
        // verification below opens a connection *as the student*, which a
        // NOLOGIN role cannot do. The reconciler restores archived accounts —
        // `canLogin: false` — so without this the one check that makes this
        // method worth having would fail on exactly the unattended path, after
        // the data had already landed. The requested state is applied at the
        // end, and the window is a few milliseconds inside one function on an
        // account that has no sessions.
        await ensureStudentRole({ ...spec, canLogin: true });

        const { listFile, expected, cleanup } = await restoreListWithoutSchema(target, pgRole);
        releaseList = cleanup;

        await execFileAsync(
          config.provisioning.pgRestore,
          [
            '--single-transaction', // implies --exit-on-error: all of it, or none
            `--role=${pgRole}`, // SET ROLE, so the student creates their own objects
            '--no-owner', // ownership is right by construction; nothing to ALTER
            '--no-privileges', // the roster decides who may read, not the dump
            `--use-list=${listFile}`,
            `--dbname=${config.pg.teachDb}`,
            `--host=${config.pg.host}`,
            `--port=${String(config.pg.port)}`,
            `--username=${config.pg.user}`,
            '--no-password',
            target,
          ],
          {
            env: { ...process.env, PGPASSWORD: config.pg.password },
            timeout: config.provisioning.dumpTimeoutMs,
            maxBuffer: 4 * 1024 * 1024,
          },
        );

        // Twice, and the second is not redundant. The first call had an empty
        // schema, so its `GRANT SELECT ON ALL TABLES` covered nothing; the
        // tables exist now. `ALTER DEFAULT PRIVILEGES` should have covered them
        // anyway — they were created by the student, which is what that clause
        // keys on — but a teacher's view of a restored class should not rest on
        // "should have", and the call is idempotent.
        await ensureStudentRole({ ...spec, canLogin: true });

        const { rows: owned } = await teachDb.query<{ n: string }>(
          // relkind r and p only, to match what `information_schema.tables`
          // reports as BASE TABLE below. Materialised views are absent from that
          // view entirely, so counting them here would make a restore look short.
          `SELECT count(*)::text AS n
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`,
          [pgRole],
        );
        const tables = Number(owned[0]?.n ?? 0);

        const pool = getUserPool(pgRole, spec.pgPassword);
        const { rows: visible } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM information_schema.tables
            WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
          [pgRole],
        );
        const readable = Number(visible[0]?.n ?? 0);

        if (tables !== expected) {
          throw new Error(
            `the dump lists ${String(expected)} tables for ${pgRole} but ${String(tables)} landed`,
          );
        }
        if (readable !== tables) {
          throw new Error(
            `restored ${String(tables)} tables into ${pgRole} but the student can see ` +
              `${String(readable)} — the rows are on disk and their owner cannot reach them`,
          );
        }

        // Only now the login state the caller actually asked for. An archived
        // account restored by the reconciler goes back to NOLOGIN here.
        if (!spec.canLogin) {
          await teachDb.query(`ALTER ROLE ${quoteIdent(pgRole)} NOLOGIN`);
          await dropUserPool(pgRole);
        }

        return { tables, readable };
      } catch (err) {
        // **Leave the account cold-shaped, or this failure is permanent.**
        //
        // The caller only clears `archive_path` on success, and the reconciler's
        // retry fires only for an account with *no* schema. So a schema left
        // behind here — empty, half-built, or fully restored but unverified —
        // puts the account in a state nothing repairs and nothing reports: the
        // dump stays named by a row whose schema already exists, every later
        // reactivation dies on the "already exists" guard above, and
        // `reportIsClean` says the instance is healthy.
        //
        // NOLOGIN too, and not `spec.canLogin`. A restore that failed leaves a
        // student with no schema; letting them log in to that is a worse answer
        // than telling them they cannot, and the row will say the restore failed
        // either way. The reconciler puts LOGIN back when it succeeds.
        await teachDb
          .tx((q) =>
            asRole(q, pgRole, () => q.query(`DROP SCHEMA IF EXISTS ${quoteIdent(pgRole)} CASCADE`)),
          )
          .catch(() => {});
        await teachDb.query(`ALTER ROLE ${quoteIdent(pgRole)} NOLOGIN`).catch(() => {});
        await dropUserPool(pgRole).catch(() => {});

        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`restore of schema ${pgRole} failed: ${detail}`);
      } finally {
        await releaseList();
      }
    },

    /**
     * Bytes per provisioned schema, for the quota report.
     *
     * `pg_total_relation_size` includes indexes and TOAST, which is what a disk
     * quota should count. Enforcement is phase 3's job — it needs the query
     * runner to have somewhere to refuse a write.
     */
    async schemaUsage(only) {
      // A bind parameter, not concatenation: this file is allowed to build SQL
      // by string for DDL, and that licence does not extend to a WHERE clause
      // that takes parameters perfectly well. `$1 IS NULL` keeps one query
      // rather than two that could drift apart.
      // Relations only, and **large objects are handled by not existing** rather
      // than by being counted here. They live in `pg_largeobject`, which belongs
      // to no schema, so this query structurally cannot see them — and sizing
      // them needs `SELECT` on `pg_largeobject`, which is superuser-only. An
      // attempt to join it here made `schemaUsage` throw `42501` for every
      // caller, i.e. broke the admin usage report and the lesson view outright.
      //
      // So the control is upstream: `db/init/00-bootstrap.sh` revokes EXECUTE
      // on the large-object constructors from PUBLIC, so a student cannot make
      // one at all. `resetSchema` and `archiveAndDrop` still `DROP OWNED BY`,
      // which clears any that predate that revoke.
      //
      // The pattern matches exercise workspaces (`x7_u_k3a_muster_lena`) as well
      // as playgrounds, since phase 9. They are disk a student is using, on the
      // same disk, and leaving them out would make the quota a limit on half of
      // what they own — with the invisible half growing every time a teacher
      // hands out an exercise. Attribution is the caller's: `services/quota.ts`
      // sums one student's schemas into one number, and only the admin report
      // renders the rows separately.
      const { rows } = await teachDb.query<{ schema: string; bytes: string }>(
        `SELECT n.nspname AS schema,
                coalesce(sum(pg_total_relation_size(c.oid)), 0)::text AS bytes
           FROM pg_namespace n
           LEFT JOIN pg_class c
             ON c.relnamespace = n.oid AND c.relkind IN ('r', 'm', 'p')
          WHERE n.nspname ~ '^([ut]_|x[0-9]+_)'
            AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
          GROUP BY n.nspname
          ORDER BY 2 DESC`,
        [only ?? null],
      );
      return rows.map((r) => ({ schema: r.schema, bytes: Number(r.bytes) }));
    },

    async inventory(names) {
      const wanted = names.filter(isSafeName);
      const roles: Inventory['roles'] = new Map();
      const schemas = new Set<string>();
      const usageGrants = new Map<string, Set<string>>();
      if (wanted.length === 0) return { roles, schemas, usageGrants };

      // `has_database_privilege` rather than picking `datacl` apart, on the same
      // principle as the bootstrap's collation probe: ask whether the thing
      // works, not whether a particular ACL entry is spelled a particular way.
      // The database name is a bind parameter — this file's licence to build SQL
      // by string is for DDL, and it does not extend to a value that binds.
      const { rows: roleRows } = await teachDb.query<{
        rolname: string;
        rolcanlogin: boolean;
        canconnect: boolean;
        hassettings: boolean;
      }>(
        // `pg_db_role_setting` is where `ALTER ROLE ... SET` lands. `setdatabase
        // = 0` is the cluster-wide form, which is the one `roleSettings` uses.
        // Checked for the presence of `statement_timeout` specifically rather
        // than for a non-empty array: `RESET ALL` deletes the row entirely, but
        // resetting one setting leaves the others behind, and the partial case
        // should repair too.
        `SELECT r.rolname, r.rolcanlogin,
                has_database_privilege(r.rolname, $2, 'CONNECT') AS canconnect,
                coalesce(s.setconfig::text[] && ARRAY(
                  SELECT 'statement_timeout=' || $3::text
                ), false) AS hassettings
           FROM pg_roles r
           LEFT JOIN pg_db_role_setting s
             ON s.setrole = r.oid AND s.setdatabase = 0
          WHERE r.rolname = ANY($1::text[])`,
        [wanted, config.pg.teachDb, config.limits.statementTimeout],
      );
      for (const r of roleRows) {
        roles.set(r.rolname, {
          canLogin: r.rolcanlogin,
          canConnect: r.canconnect,
          hasSettings: r.hassettings,
        });
      }

      const { rows: schemaRows } = await teachDb.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])`,
        [wanted],
      );
      for (const s of schemaRows) schemas.add(s.nspname);

      // aclexplode over nspacl is the only way to read schema privileges —
      // information_schema has no view for them. A schema still carrying its
      // default ACL has nspacl NULL, and the LATERAL then yields no rows, which
      // is exactly right: no explicit grants.
      //
      // **`grantee = 0` IS `PUBLIC`, and this used to filter it out** with an
      // `AND a.grantee <> 0`. That made the widest possible grant the one thing
      // the reconciler could not see: a student who ran `GRANT USAGE ON SCHEMA
      // u_me TO PUBLIC` opened their schema to every account in the school,
      // permanently, and the repair pass reported the instance clean. The
      // peer-to-peer case `reconcileGrants` documents was caught; the strictly
      // wider one was not.
      //
      // It comes back as the literal `PUBLIC` rather than whatever
      // `pg_get_userbyid(0)` says, because that is the token a REVOKE needs —
      // and it cannot collide with a real grantee, since every role this app
      // creates is lowercase `u_`/`t_`.
      const { rows: aclRows } = await teachDb.query<{ schema: string; grantee: string }>(
        `SELECT n.nspname AS schema,
                CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
           FROM pg_namespace n
           CROSS JOIN LATERAL aclexplode(n.nspacl) a
          WHERE n.nspname = ANY($1::text[])
            AND a.privilege_type = 'USAGE'
            AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) <> n.nspname)`,
        [wanted],
      );
      for (const row of aclRows) {
        let set = usageGrants.get(row.schema);
        if (!set) usageGrants.set(row.schema, (set = new Set()));
        set.add(row.grantee);
      }

      return { roles, schemas, usageGrants };
    },
  };
}

function isSafeName(name: string): boolean {
  try {
    assertRoleName(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * `pg_dump -Fc` of one schema into the archive directory.
 *
 * Connects as `dbk_app` and uses `--role`, which issues `SET ROLE` after
 * connecting. That matters: `dbk_app` holds NOINHERIT membership and therefore
 * has no SELECT on a single student table, so a plain dump would produce an
 * empty archive and report success. Connecting as the student directly would
 * work too, but not for an archived account — the role is NOLOGIN by then, and
 * this is called on exactly that path.
 *
 * The password is passed in the environment rather than the command line so it
 * does not show up in `ps`.
 */
async function dumpSchema(pgRole: string): Promise<string> {
  assertRoleName(pgRole);
  // 0700 to match the 0600 on the files below and `db/backup.sh`'s directory.
  await mkdir(config.paths.archive, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(config.paths.archive, `${pgRole}-${stamp}.dump`);

  try {
    await execFileAsync(
      config.provisioning.pgDump,
      [
        '--format=custom',
        `--schema=${pgRole}`,
        `--role=${pgRole}`,
        `--file=${target}`,
        `--host=${config.pg.host}`,
        `--port=${String(config.pg.port)}`,
        `--username=${config.pg.user}`,
        '--no-password',
        config.pg.teachDb,
      ],
      {
        env: { ...process.env, PGPASSWORD: config.pg.password },
        timeout: config.provisioning.dumpTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`pg_dump of schema ${pgRole} failed, refusing to drop it: ${detail}`);
  }

  // 0600, because this file is one student's entire database.
  //
  // `pg_dump --file=` creates with the process umask, which in the container is
  // 022 — so these landed 0644 and the directory 0755, world-readable on the
  // bulk disk. `db/backup.sh` is meticulous about exactly this (700 on the
  // directory, 600 on every dump) and the mismatch was the surprising part: two
  // paths writing the same kind of secret to the same disk under different
  // rules. Applied after the write rather than via a umask, so it is visible at
  // the site that produces the file.
  await chmod(target, 0o600);

  return target;
}

/**
 * A `pg_restore --use-list` file for one dump, with the schema entry removed.
 *
 * `pg_restore -l` prints the archive's table of contents, one entry per line:
 *
 *   215; 2615 16456 SCHEMA - u_k3a_muster_lena dbk_app
 *   216; 1259 16457 TABLE u_k3a_muster_lena kunden u_k3a_muster_lena
 *   3456; 0 16457 TABLE DATA u_k3a_muster_lena kunden u_k3a_muster_lena
 *
 * Feeding it back with `--use-list` restores exactly the entries listed, and
 * `pg_restore` ignores lines beginning with `;` — so dropping the SCHEMA line is
 * the whole edit. That is what lets the restore run as the student: they cannot
 * execute `CREATE SCHEMA`, and `ensureStudent` has already made it for them.
 *
 * It also returns how many tables the dump *claims* to hold, read from the
 * archive rather than from the database, which is the only count in
 * `restoreStudent`'s three-way check that does not depend on the restore having
 * worked. `--single-transaction` already makes a partial restore impossible, so
 * a mismatch means this parser or this filter is wrong — which is precisely the
 * thing a hand-rolled TOC filter should be made to prove about itself.
 */
async function restoreListWithoutSchema(
  dumpPath: string,
  pgRole: string,
): Promise<{ listFile: string; expected: number; cleanup: () => Promise<void> }> {
  const { stdout } = await execFileAsync(config.provisioning.pgRestore, ['--list', dumpPath], {
    // The same timeout the restore itself gets. Without one, a truncated dump or
    // a stalled archive mount hangs this child forever — and the boot reconcile
    // calls it before `app.listen`, so the process would look alive and serve
    // nothing, with no error and no log line to explain it.
    timeout: config.provisioning.dumpTimeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });

  // `dumpId; tableoid oid DESC ...` — the description can be several words
  // ("TABLE DATA", "FK CONSTRAINT"), so only the first is matched, and only
  // `SCHEMA`, which is never the first word of any other entry type.
  const ENTRY = /^\d+;\s+\d+\s+\d+\s+(\S+)/;
  const kept: string[] = [];
  let expected = 0;
  for (const line of stdout.split('\n')) {
    const desc = ENTRY.exec(line)?.[1];
    if (desc === 'SCHEMA') continue;
    // `TABLE` but not `TABLE DATA`, which is the rows rather than the relation.
    if (desc === 'TABLE' && !/^\d+;\s+\d+\s+\d+\s+TABLE\s+DATA\s/.test(line)) expected += 1;
    kept.push(line);
  }

  const dir = await mkdtemp(join(tmpdir(), `dbk-restore-${pgRole}-`));
  const listFile = join(dir, 'toc.list');
  await writeFile(listFile, kept.join('\n'), 'utf8');
  return { listFile, expected, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * A provisioner that does nothing, for tests that drive the services against
 * PGlite — which is single-user and cannot execute a single GRANT.
 *
 * `calls` records what *would* have happened, which is what makes the seam
 * orchestration testable without a server: whether removing a student from one
 * of two classes with the same teacher revokes the grant is a decision made in
 * `classes.ts`, not in SQL, and this is where that decision gets asserted.
 */
export interface RecordedCall {
  op: string;
  args: unknown[];
}

export interface RecordingOptions {
  /**
   * What `inventory()` should claim already exists. The reconciler's whole job
   * is to diff this against `app_user`, so a test that wants to exercise it has
   * to be able to state the "before".
   */
  inventory?: Partial<Inventory>;
  /**
   * Operations that should throw, and with what. Used to check that a seam
   * failing after its transaction committed leaves an audit row and a reported
   * outcome rather than a 500.
   */
  failing?: Record<string, string>;
  /** `reconcile` short-circuits on a non-live provisioner; set true to drive it. */
  live?: boolean;
  /**
   * Bytes per schema for `schemaUsage()`. PGlite cannot answer the real query
   * (it measures the *teaching* database, which the service tests do not have),
   * so the lesson view's quota column is driven from here.
   */
  usage?: SchemaUsage[];
  /**
   * What `archiveAndDrop` and `coldStore` should claim they wrote. Null by
   * default, which is the "there was no schema to dump" case; a test that cares
   * whether `archive_path` gets recorded has to be able to state a path.
   */
  archivePath?: string;
  /**
   * Exercise workspaces per student role, for `listWorkspaces()`. PGlite stands
   * in for the *meta* database in these tests and holds no `pg_namespace` for
   * the teaching one, so a test about what the quota measures — or about
   * `takeBack` dropping what it should — has to be able to state which schemas
   * exist.
   */
  workspaces?: Record<string, string[]>;
  /** What `createWorkspace` should report. Defaults to "I made it". */
  workspaceCreated?: boolean;
}

export function recordingProvisioner(
  options: RecordingOptions = {},
): Provisioner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const failing = options.failing ?? {};

  const record =
    (op: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push({ op, args });
      const message = failing[op];
      if (message !== undefined) throw new Error(message);
    };

  return {
    calls,
    live: options.live ?? false,
    ensureTeacher: record('ensureTeacher'),
    ensureStudent: record('ensureStudent'),
    grantTeacher: record('grantTeacher'),
    revokeTeacher: record('revokeTeacher'),
    setLogin: record('setLogin'),
    applyRoleSettings: record('applyRoleSettings'),
    grantConnect: record('grantConnect'),
    resetSchema: record('resetSchema'),
    async createWorkspace(studentRole, schema, teacherRoles) {
      await record('createWorkspace')(studentRole, schema, teacherRoles);
      // `created` is what decides whether the fixtures get replayed, so a test
      // about "opening an exercise twice does not wipe my work" has to be able
      // to say which of the two it is driving.
      return { created: options.workspaceCreated ?? true };
    },
    dropWorkspace: record('dropWorkspace'),
    async listWorkspaces(studentRole) {
      calls.push({ op: 'listWorkspaces', args: [studentRole] });
      return options.workspaces?.[studentRole] ?? [];
    },
    async archiveAndDrop(pgRole) {
      await record('archiveAndDrop')(pgRole);
      return options.archivePath ?? null;
    },
    async coldStore(pgRole) {
      await record('coldStore')(pgRole);
      return options.archivePath ?? null;
    },
    async restoreStudent(spec) {
      await record('restoreStudent')(spec);
      // A plausible non-empty restore, so a caller that checks the result is
      // exercised rather than short-circuited by a zero.
      return { tables: 1, readable: 1 };
    },
    async schemaUsage(only) {
      // Recorded like the rest: *which* schemas a caller asked about is the
      // assertion that stops the class-scoped view quietly widening back to the
      // whole instance.
      calls.push({ op: 'schemaUsage', args: [only] });
      const all = options.usage ?? [];
      return only === undefined ? all : all.filter((u) => only.includes(u.schema));
    },
    async inventory() {
      return {
        roles: options.inventory?.roles ?? new Map(),
        schemas: options.inventory?.schemas ?? new Set(),
        usageGrants: options.inventory?.usageGrants ?? new Map(),
      };
    },
  };
}
