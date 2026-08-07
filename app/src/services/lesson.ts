/**
 * The teacher's live lesson view — phase 4.
 *
 * Reads what phase 3 wrote. Nothing here touches the teaching database except
 * through the provisioner's `schemaUsage`, and nothing here can see a student
 * the caller does not already teach: the route asserts class access first and
 * this is driven from that class's roster.
 *
 * ## Why the quota is in this view at all
 *
 * A quota refusal deliberately writes **no** `query_log` row (HANDOFF §4s): the
 * check throws before the runner opens a connection, and a row claiming a
 * student ran `CREATE TABLE` when they were refused would be a lie in the one
 * place a teacher trusts. That decision stands. But it leaves this view with a
 * hole, and it is exactly the hole that matters: a student who is being refused
 * on every keystroke renders identically to a student who has typed nothing,
 * and noticing the stuck one is the whole reason this screen exists.
 *
 * The fix is not to log the refusal. A refusal is not an event, it is a
 * *state* — they are over quota now and will be refused again on the next
 * attempt — so the view carries the state beside the activity and the silence
 * explains itself. `query_log` keeps meaning "this reached Postgres", and the
 * teacher gets something strictly more useful than a refusal row would have
 * been, because it says the condition is still true rather than that something
 * once happened.
 *
 * ## Two words this deliberately does not use
 *
 * **"Online".** The app cannot know that. It knows a student holds an unexpired
 * session, which is a much weaker claim — a browser closed an hour ago still
 * has one. The field is `signedIn` and the page says "angemeldet", so a teacher
 * reading it is not invited to conclude anything about who is at their desk.
 * `lastStatementAt` is the field that actually answers "is anyone working".
 *
 * **"Idle".** Nothing here reports a student as idle, because between "typed
 * nothing", "thinking", "reading the task" and "refused every time" this view
 * can only distinguish the last one. It reports what it knows and lets the
 * teacher conclude.
 */

import type { Db, Queryable } from '../db/query.js';
import type { Provisioner } from './provision.js';
import { listStudents, type PublicUser } from './users.js';

/** One row of `query_log`, as the view shows it. */
export interface LessonStatement {
  sql: string;
  at: string;
  durationMs: number | null;
  rowCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface LessonQuota {
  bytes: number;
  quotaBytes: number;
  /** True means every growing statement is currently being refused (§4s). */
  overQuota: boolean;
}

export interface LessonStudent {
  userId: number;
  username: string;
  displayName: string;
  /** Their schema name, and their Postgres role. Null if never provisioned. */
  pgRole: string | null;
  /** Holds an unexpired session. NOT "is at their desk" — see the header. */
  signedIn: boolean;
  /** The most recent statement ever, not just within the window. */
  lastStatement: LessonStatement | null;
  /** Statements that reached Postgres inside the window. */
  statements: number;
  /** How many of those came back with a SQLSTATE. */
  errors: number;
  /** Null when the account has no schema to measure. */
  quota: LessonQuota | null;
}

export interface LessonView {
  classId: number;
  windowMinutes: number;
  /** The start of the counting window, so the page can label it honestly. */
  since: string;
  students: LessonStudent[];
}

export interface LessonDetail {
  student: LessonStudent;
  /** Newest first. */
  statements: LessonStatement[];
}

interface ActivityRow {
  userId: string;
  statements: string;
  errors: string;
}

interface LastRow {
  userId: string;
  sqlText: string;
  createdAt: Date | string;
  durationMs: number | null;
  rowCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Counts inside the window, one row per student who ran anything.
 *
 * A student with no rows is absent rather than zero — assembling the roster
 * from `app_user` and left-joining this in JS keeps "enrolled but has not run
 * anything" and "not in this class" from collapsing into the same shape, which
 * is the same mistake `catalog.ts` avoids with its LEFT JOIN.
 */
const ACTIVITY_QUERY = `
  SELECT user_id                                              AS "userId",
         count(*)                                             AS statements,
         count(*) FILTER (WHERE error_code IS NOT NULL)       AS errors
    FROM query_log
   WHERE user_id = ANY($1::bigint[])
     AND created_at >= $2::timestamptz
   GROUP BY user_id`;

/**
 * The latest statement per student, with no window bound.
 *
 * Deliberately not restricted to the window: "last thing Lena ran was 40
 * minutes ago" is a more useful answer than an empty cell, and the timestamp
 * travels with it so nothing is implied about when. `DISTINCT ON` reads
 * straight off `query_log_user_time_idx (user_id, created_at DESC)`.
 */
const LAST_STATEMENT_QUERY = `
  SELECT DISTINCT ON (user_id)
         user_id       AS "userId",
         sql_text      AS "sqlText",
         created_at    AS "createdAt",
         duration_ms   AS "durationMs",
         row_count     AS "rowCount",
         error_code    AS "errorCode",
         error_message AS "errorMessage"
    FROM query_log
   WHERE user_id = ANY($1::bigint[])
   ORDER BY user_id, created_at DESC`;

const SIGNED_IN_QUERY = `
  SELECT DISTINCT user_id AS "userId"
    FROM session
   WHERE user_id = ANY($1::bigint[])
     AND expires_at > now()`;

const RECENT_QUERY = `
  SELECT sql_text      AS "sqlText",
         created_at    AS "createdAt",
         duration_ms   AS "durationMs",
         row_count     AS "rowCount",
         error_code    AS "errorCode",
         error_message AS "errorMessage"
    FROM query_log
   WHERE user_id = $1
   ORDER BY created_at DESC
   LIMIT $2`;

export const DEFAULT_WINDOW_MINUTES = 90;
export const MAX_WINDOW_MINUTES = 24 * 60;
export const MIN_WINDOW_MINUTES = 5;
/** Enough to scroll through what a student did this lesson, not their term. */
export const DETAIL_STATEMENTS = 50;

function statement(row: Omit<LastRow, 'userId'>): LessonStatement {
  return {
    sql: row.sqlText,
    at: new Date(row.createdAt).toISOString(),
    durationMs: row.durationMs,
    rowCount: row.rowCount,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

export interface LessonReaderDeps {
  /** The meta database — the roster, the log and the sessions all live here. */
  db: Db;
  /** Only for `schemaUsage`; the view never provisions anything. */
  prov: Provisioner;
  /** From `config.limits.studentQuotaMb`, passed in so tests can vary it. */
  quotaBytes: number;
  /**
   * Which exercise workspaces each of these students holds — phase 9.
   *
   * Injected rather than queried here, and rather than this file taking the
   * whole exercise service. The query belongs to `exercise_workspace`, which is
   * `services/exercise.ts`'s table; a second copy of it living here is the copy
   * that does not get updated when the table changes. One function, passed in,
   * is also what lets the service tests state the answer.
   */
  workspacesByUser: (userIds: number[]) => Promise<Map<number, string[]>>;
}

export interface LessonReader {
  read(classId: number, windowMinutes?: number): Promise<LessonView>;
  /** One student's recent statements. The caller has already checked access. */
  detail(classId: number, userId: number): Promise<LessonDetail | undefined>;
}

export function clampWindow(minutes: number | undefined): number {
  if (minutes === undefined || !Number.isFinite(minutes)) return DEFAULT_WINDOW_MINUTES;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, Math.trunc(minutes)));
}

export function makeLessonReader(deps: LessonReaderDeps): LessonReader {
  const { db, prov, quotaBytes, workspacesByUser } = deps;

  async function assemble(
    roster: PublicUser[],
    windowMinutes: number,
  ): Promise<{ since: Date; students: LessonStudent[] }> {
    const since = new Date(Date.now() - windowMinutes * 60_000);
    const ids = roster.map((s) => s.id);

    if (ids.length === 0) return { since, students: [] };

    // Only the schemas of this class. `schemaUsage()` with no argument answers
    // for every schema in the instance, which is a roster of every other
    // teacher's students — the same disclosure that keeps /api/admin/usage
    // admin-only. Filtering here would be enough to stop it reaching the
    // client; pushing it into the query means we never hold it.
    const pgRoles = roster.map((s) => s.pgRole).filter((r): r is string => r !== null);

    // Phase 9: a student's disk is their playground schema **plus** one per
    // exercise they have opened, and the roster shows one number per student.
    // Asking only for `pgRoles` under-reports, and it under-reports by more the
    // more a class actually uses the feature — the shape of wrong that looks
    // fine right up until someone is refused a write at "12 of 50 MB".
    //
    // Still narrowed to this class. `schemaUsage()` with no argument answers for
    // every schema in the instance, which is a roster of every other teacher's
    // students; that is why the list is built up rather than the filter dropped.
    const workspaces = await workspacesByUser(ids);
    const schemas = [...pgRoles, ...[...workspaces.values()].flat()];

    const [activity, last, sessions, usage] = await Promise.all([
      db.query<ActivityRow>(ACTIVITY_QUERY, [ids, since.toISOString()]),
      db.query<LastRow>(LAST_STATEMENT_QUERY, [ids]),
      db.query<{ userId: string }>(SIGNED_IN_QUERY, [ids]),
      schemas.length > 0 ? prov.schemaUsage(schemas) : Promise.resolve([]),
    ]);

    const counts = new Map(activity.rows.map((r) => [Number(r.userId), r]));
    const lastByUser = new Map(last.rows.map((r) => [Number(r.userId), r]));
    const signedIn = new Set(sessions.rows.map((r) => Number(r.userId)));
    const bytesBySchema = new Map(usage.map((u) => [u.schema, u.bytes]));

    const students = roster.map((s): LessonStudent => {
      const counted = counts.get(s.id);
      const latest = lastByUser.get(s.id);

      // A provisioned student with no tables has no row in schemaUsage's
      // GROUP BY at all, which is 0 bytes and not "unknown". Only a missing
      // pgRole means there is nothing to measure.
      //
      // Summed over their exercise workspaces as well, which is where the
      // attribution happens: `schemaUsage` keys by schema and knows nothing
      // about who owns what.
      const bytes =
        s.pgRole === null
          ? null
          : (bytesBySchema.get(s.pgRole) ?? 0) +
            (workspaces.get(s.id) ?? []).reduce((sum, w) => sum + (bytesBySchema.get(w) ?? 0), 0);

      return {
        userId: s.id,
        username: s.username,
        displayName: s.displayName,
        pgRole: s.pgRole,
        signedIn: signedIn.has(s.id),
        lastStatement: latest ? statement(latest) : null,
        statements: counted ? Number(counted.statements) : 0,
        errors: counted ? Number(counted.errors) : 0,
        quota: bytes === null ? null : { bytes, quotaBytes, overQuota: bytes > quotaBytes },
      };
    });

    return { since, students };
  }

  return {
    async read(classId, windowMinutes) {
      const window = clampWindow(windowMinutes);
      const roster = await listStudents(db, { classId });
      const { since, students } = await assemble(roster, window);
      return { classId, windowMinutes: window, since: since.toISOString(), students };
    },

    async detail(classId, userId) {
      // Re-read the roster rather than trusting the id: it is what proves this
      // student is in the class the caller was authorised for. A teacher who
      // guesses a student id belonging to another class gets undefined, which
      // the route turns into a 404.
      const roster = await listStudents(db, { classId });
      if (!roster.some((s) => s.id === userId)) return undefined;

      const { students } = await assemble(
        roster.filter((s) => s.id === userId),
        DEFAULT_WINDOW_MINUTES,
      );
      const student = students[0];
      if (!student) return undefined;

      const recent = await (db as Queryable).query<Omit<LastRow, 'userId'>>(RECENT_QUERY, [
        userId,
        DETAIL_STATEMENTS,
      ]);

      return { student, statements: recent.rows.map(statement) };
    },
  };
}
