/**
 * The query runner — phase 3.
 *
 * Takes SQL a student typed, runs it *as that student's Postgres role*, and
 * returns one result per statement. Isolation is not enforced anywhere in this
 * file: the connection is opened as the student (db/pools.ts), so every
 * permission question is answered by Postgres. What this file owns is the
 * things Postgres will not do for us — the wall-clock limit, the row cap, and
 * leaving the pooled connection fit for the next request.
 *
 * ## The simple query protocol, on purpose
 *
 * A lesson wants `SELECT …; SELECT …;` in the editor to produce two grids
 * (ARCHITECTURE §4). That needs the simple protocol, which is what node-postgres
 * uses when a query carries no bind parameters — so the student's SQL is sent
 * as one string and comes back as an array of results. Nothing here interpolates
 * anything into it: the text is the student's, the whole statement, and it is
 * privileged exactly as far as their role is.
 *
 * ## Why the rows are streamed rather than sliced
 *
 * The 1000-row fetch cap cannot be applied after the fact. `SELECT * FROM
 * generate_series(1, 1e9)` would put every row in the Node heap before we ever
 * saw the result, and take the process — and with it everybody else's lesson —
 * down well before any timeout fired. So we attach a `row` listener, which
 * makes node-postgres stop accumulating into the result (`_accumulateRows` in
 * pg/lib/query.js) and hand each row straight to us; we keep the first 1000 and
 * drop the rest.
 *
 * The statement still runs to completion, deliberately. Postgres reports the
 * true row count in the CommandComplete tag, so letting it finish is what turns
 * a truncated grid into an honest "showing the first 1000 of 4,812" instead of
 * a silent lie. Memory is already bounded by then, and the wall clock is bounded
 * by the watchdog.
 */

import pg from 'pg';
import { config } from '../config.js';
import type { Db } from '../db/query.js';
import { mayGrow, type QuotaGuard } from './quota.js';
import { pgIdentity, ServiceError } from './users.js';
import type { CancelReason, Watchdog } from './watchdog.js';

/**
 * Longer than any lesson needs and far below the 12 MB body limit. Exists so a
 * pasted file cannot become a multi-megabyte `query_log` row.
 */
export const MAX_SQL_LENGTH = 100_000;

export interface Column {
  name: string;
  dataTypeId: number;
}

export interface StatementResult {
  /** `SELECT`, `INSERT`, … — null for a statement that returned no tag. */
  command: string | null;
  columns: Column[];
  /** Row arrays, not objects: see `rowMode` below. At most `maxResultRows`. */
  rows: unknown[][];
  /** What Postgres reported — the *true* total, even when `rows` is truncated. */
  rowCount: number;
  truncated: boolean;
}

export interface QueryError {
  /** SQLSTATE. Drives the localised hint layer in phase 6. */
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  /** 1-based character offset into the SQL. Postgres gives us this and it is gold for beginners. */
  position?: number;
}

export interface QueryOutcome {
  ok: boolean;
  statements: StatementResult[];
  durationMs: number;
  error?: QueryError;
  /** Present when the statement was stopped rather than having failed on its own. */
  cancelled?: { reason: CancelReason };
}

/**
 * Which of the caller's schemas this script is being run against — phase 9.
 *
 * Absent means their playground, which is what `search_path`'s `"$user"` already
 * resolves to and therefore needs no statement at all. Present means one of
 * their exercise workspaces, and the runner sets `search_path` for the duration.
 */
export interface QueryContext {
  exerciseId: number;
  schema: string;
}

export interface QueryRunner {
  run(userId: number, sql: string, context?: QueryContext | undefined): Promise<QueryOutcome>;
  /** The Cancel button. Returns how many backends were signalled. */
  cancel(userId: number): Promise<number>;
}

export interface QueryRunnerDeps {
  /** The meta database — identities in, `query_log` out. */
  db: Db;
  watchdog: Watchdog;
  /** The per-schema disk limit. Measures against the *teaching* database. */
  quota: QuotaGuard;
  /**
   * A pool connected *as the student*. Injected rather than imported so the
   * tests can drive the real function against a fake, the same way services
   * take a `Provisioner`.
   */
  getPool: (pgRole: string, pgPassword: string) => pg.Pool;
}

/** SQLSTATE for "canceling statement due to …" — both user request and statement timeout. */
const QUERY_CANCELED = '57014';

/**
 * Run the script and collect at most `maxRows` rows per statement.
 *
 * Uses `pg.Query` directly rather than `client.query(sql)` because only the
 * event form streams; the promise form accumulates everything first. See the
 * header for why that distinction is load-bearing rather than an optimisation.
 */
/**
 * What we read back off a node-postgres Result. Declared locally because
 * `@types/pg` types the `end` payload as a single `ResultBuilder`, while the
 * runtime hands over an array as soon as the script holds more than one
 * statement — which is the case this whole function exists for.
 */
interface RawResult {
  command?: string;
  rowCount?: number | null;
  fields?: { name: string; dataTypeID: number }[];
}

/**
 * Postgres date/time OIDs: `date`, `timestamp`, `timestamptz`, `time`, `timetz`.
 */
const DATE_TIME_OIDS = new Set([1082, 1114, 1184, 1083, 1266]);

/**
 * Show the student what Postgres said, not what JavaScript made of it.
 *
 * node-postgres parses a `date` into a JS `Date` at **local** midnight. Serialised
 * for the grid that becomes `2025-04-02T22:00:00.000Z` — the day before the one
 * in the table, because Zurich is UTC+2 in April. It is not a rounding
 * infelicity: a student who imports `03.04.2025`, checks the result grid and
 * reads 2 April has been told their data is wrong when it is not, and the whole
 * point of the CSV coercion layer (services/csv.ts) is undone at the last step.
 *
 * `timestamptz` has the same problem in reverse, and `time` comes back as a
 * bare string that then gets a fabricated date attached to it.
 *
 * So these five types are handed over as the text Postgres sent. That is also
 * simply the right answer for a teaching tool: the result grid should show what
 * `SELECT` shows in `psql`, and a lesson about time zones should be a lesson
 * about time zones rather than an artefact of the driver.
 *
 * Scoped to this query rather than set with the global `pg.types.setTypeParser`,
 * which would also change every `created_at` the meta database returns and with
 * it the shape of half the API.
 */
const GRID_TYPES = {
  getTypeParser: (oid: number, format?: string) =>
    DATE_TIME_OIDS.has(oid)
      ? (value: string) => value
      : (pg.types.getTypeParser as (oid: number, format?: string) => unknown)(oid, format),
};

/**
 * A cheap size estimate for one retained row, in UTF-16 units.
 *
 * Estimate, not measurement — `Buffer.byteLength` per cell over a thousand-row
 * grid to sharpen a number whose only job is "stop before the heap does" is the
 * wrong trade, and `services/quota.ts` makes the same call for the same reason.
 *
 * Strings are what actually get large (`repeat('x', 100000000)` is one cell);
 * everything else is a fixed guess, because a number, a boolean and a null all
 * cost about a pointer and none of them can be the thing that runs us out of
 * memory. `rowMode: 'array'` means a row is a flat array, so there is no
 * nesting to walk.
 */
function rowBytes(row: unknown[]): number {
  let total = 0;
  for (const cell of row) total += typeof cell === 'string' ? cell.length : 8;
  return total;
}

async function execute(
  client: pg.PoolClient,
  sql: string,
  maxRows: number,
  maxBytes: number,
): Promise<StatementResult[]> {
  // `rowMode: 'array'` is not just cheaper than objects. `SELECT 1 AS a, 2 AS a`
  // is legal SQL and a perfectly ordinary thing to type by accident while
  // learning joins; as objects the second column silently overwrites the first
  // and the grid shows one column where the student wrote two.
  //
  // The cast is `@types/pg` being incomplete: `rowMode` appears on the
  // `Client.query()` overloads but not on the `Query` constructor's config,
  // though the constructor reads it (`this._rowMode = config.rowMode`).
  const query = new pg.Query({
    text: sql,
    rowMode: 'array',
    types: GRID_TYPES,
  } as pg.QueryConfig);

  // Keyed by the per-statement Result object node-postgres hands to the
  // listener, which is how rows are attributed to their statement in a script.
  const kept = new Map<object, unknown[][]>();
  const stoppedOnBytes = new Set<object>();

  /**
   * The byte budget is for the **whole script**, not per statement.
   *
   * `maxRows` bounds the row *count*, which is the case this file's header
   * reasons about at length (`generate_series(1, 1e9)`). It says nothing about
   * row *width*, and the two are independent: `SELECT repeat('x', 100000000)
   * FROM generate_series(1,20)` is twenty rows and two gigabytes. Nothing else
   * catches it either — `statement_timeout` and the watchdog bound wall clock,
   * not bytes already buffered, and a loopback socket moves well over a
   * gigabyte inside fifteen seconds.
   *
   * One budget across the script rather than one each, because it is the whole
   * response that has to fit in memory and then serialise; ten statements each
   * just under a per-statement cap is the same OOM with extra steps.
   */
  let budget = maxBytes;

  query.on('row', (row: unknown[], result?: object) => {
    if (result === undefined) return;
    let rows = kept.get(result);
    if (rows === undefined) kept.set(result, (rows = []));
    if (rows.length >= maxRows) return;
    if (budget <= 0) {
      stoppedOnBytes.add(result);
      return;
    }
    budget -= rowBytes(row);
    rows.push(row);
  });

  const results = await new Promise<RawResult | RawResult[]>((resolve, reject) => {
    query.on('end', (r: unknown) => resolve(r as RawResult | RawResult[]));
    // Query is an EventEmitter: an 'error' with no listener is an uncaught
    // exception, not a rejected promise.
    query.on('error', reject);
    client.query(query);
  });

  return (Array.isArray(results) ? results : [results])
    // An empty script — or one that is nothing but comments — produces a result
    // with no command tag. There is no grid to draw for it.
    .filter((r) => r.command !== undefined && r.command !== null)
    .map((r) => {
      const rows = kept.get(r) ?? [];
      const rowCount = r.rowCount ?? 0;
      return {
        command: r.command ?? null,
        columns: (r.fields ?? []).map((f) => ({ name: f.name, dataTypeId: f.dataTypeID })),
        rows,
        rowCount,
        // Only "we stopped keeping rows", never "rowCount disagrees with
        // rows.length". For a statement that returns no result set, `rowCount`
        // is rows *affected* — an `INSERT` of two rows would otherwise report
        // itself as a truncated grid.
        //
        // The byte budget is the second way to stop, and it has to be reported
        // the same way: a grid silently missing its tail is worse than one that
        // says it was cut, and this is the case where a student's own query
        // produced rows too wide to hold rather than too many.
        truncated:
          (rows.length === maxRows && rowCount > rows.length) || stoppedOnBytes.has(r),
      };
    });
}

/**
 * Postgres error → the shape the editor renders.
 *
 * Unlike http/errors.ts, which refuses to echo internal messages, this one
 * passes the database's own text straight through. It is not an internal error:
 * it is the response to SQL the student wrote, about objects their own role can
 * see, and the message plus `position` is the single most useful teaching output
 * the whole application produces.
 */
export function toQueryError(err: unknown): QueryError {
  const e = err as Partial<pg.DatabaseError> & { message?: string };
  const position = e.position === undefined ? Number.NaN : Number(e.position);
  return {
    code: typeof e.code === 'string' ? e.code : 'internal_error',
    message: e.message ?? 'The query failed.',
    ...(e.detail === undefined ? {} : { detail: e.detail }),
    ...(e.hint === undefined ? {} : { hint: e.hint }),
    ...(Number.isFinite(position) ? { position } : {}),
  };
}

/**
 * Append one row to `query_log`, and never let that failure become the caller's.
 *
 * Exported because the CSV importer (services/import.ts) also runs SQL on a
 * student's behalf, and phase 4's live lesson view reads this table: an import
 * that did not appear there would leave a hole in the record exactly where a
 * student's table came from. Same reason it swallows its own errors — the SQL
 * has already run by the time we get here, so turning a lost log line into a
 * 500 would claim that nothing happened.
 */
/**
 * Delete `query_log` rows older than the retention window.
 *
 * The table holds the full text of every statement every student has ever run,
 * keyed to them by name, and nothing ever removed a row. That is a slow
 * accumulation of personal data for no purpose anyone can point at: the lesson
 * view reads the last 50 statements of the current session, so a row from last
 * spring is not serving a teacher, it is only sitting in every backup.
 *
 * A term is the unit that matters — long enough that a teacher can look back
 * over a module, short enough that the table is not a permanent record of what
 * a fifteen-year-old typed. Deleting in one statement rather than in batches
 * because at this scale the daily delete is a handful of rows.
 */
export async function pruneQueryLog(db: Db, retentionDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM query_log WHERE created_at < now() - ($1 || ' days')::interval`,
    [retentionDays],
  );
  return rowCount ?? 0;
}

let queryLogPruner: NodeJS.Timeout | undefined;

/**
 * Hourly rather than daily, and immediately on boot.
 *
 * Not because an hour of precision matters — it does not — but because a job
 * that runs once a day has a 24-hour window in which a restart means it never
 * runs at all, and this container restarts on every deploy. `unref()` so it
 * cannot hold the process open, matching the other three sweepers.
 */
export function startQueryLogPruner(
  db: Db,
  retentionDays: number,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  if (queryLogPruner) return;
  const run = (): void => {
    pruneQueryLog(db, retentionDays)
      .then((n) => {
        if (n > 0) log.info(`query_log: pruned ${n} rows older than ${retentionDays} days`);
      })
      .catch((err: unknown) => {
        log.warn(`query_log prune failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  };
  run();
  queryLogPruner = setInterval(run, 60 * 60 * 1000);
  queryLogPruner.unref();
}

export function stopQueryLogPruner(): void {
  if (queryLogPruner) clearInterval(queryLogPruner);
  queryLogPruner = undefined;
}

export async function recordQuery(
  db: Db,
  userId: number,
  sqlText: string,
  fields: {
    durationMs: number;
    rowCount: number;
    error?: QueryError | undefined;
    /** The exercise this ran against, or absent for the student's playground. */
    exerciseId?: number | undefined;
  },
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO query_log
         (user_id, sql_text, duration_ms, row_count, error_code, error_message, exercise_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        sqlText,
        fields.durationMs,
        fields.rowCount,
        fields.error?.code ?? null,
        fields.error?.message ?? null,
        fields.exerciseId ?? null,
      ],
    );
  } catch (err) {
    console.error(
      `[query_log] failed to record a query for user ${userId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

export function makeQueryRunner(deps: QueryRunnerDeps): QueryRunner {
  const { db, watchdog, quota, getPool } = deps;

  const logQuery = (
    userId: number,
    sql: string,
    outcome: QueryOutcome,
    context?: QueryContext | undefined,
  ): Promise<void> =>
    recordQuery(db, userId, sql, {
      durationMs: outcome.durationMs,
      rowCount: outcome.statements.reduce((sum, s) => sum + s.rowCount, 0),
      error: outcome.error,
      exerciseId: context?.exerciseId,
    });

  return {
    async run(userId, sql, context) {
      const identity = await pgIdentity(db, userId);
      if (!identity) {
        // An admin, or an account whose provisioning never completed. The
        // reconciler fixes the second; neither can run SQL right now.
        throw new ServiceError('not_provisioned', 'This account has no database of its own.');
      }
      if (identity.state !== 'active') {
        throw new ServiceError('user_not_active', 'This account is not active.');
      }

      // The scan comes first so that the round trip is only paid by a script
      // that could actually add data — a lesson is mostly SELECTs, and those
      // now cost nothing at all. It also means the refusal happens before a
      // connection is taken out of the student's pool of two: being over quota
      // must not look like `too_many_queries`.
      //
      // Note what is *not* being claimed. This refuses the next growing script
      // once they are already over; it cannot refuse the one that takes them
      // there, because nothing knows how big a statement's output is until it
      // has run. The watchdog bounds that one. See services/quota.ts.
      if (mayGrow(sql)) await quota.check(identity.pgRole);

      const pool = getPool(identity.pgRole, identity.pgPassword);

      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (err) {
        // The pool is at `poolMaxPerUser` and nothing came free within
        // `connectionTimeoutMillis`. Usually the student's own previous query
        // still running — a far better thing to say than the driver's
        // "timeout exceeded when trying to connect".
        //
        // "Usually", and the message says so. Stating the likely cause as the
        // known one is what hid §4dd for a day: the database had stopped
        // granting CONNECT entirely, every student saw "your previous query is
        // still running", and the sentence was confident enough that nobody
        // looked further. The catalogues (`error.too_many_queries`) carry the
        // student-facing version of this and were fixed first; this is the
        // developer-facing twin, which is what reaches the log, `curl` and
        // anything without a catalogue.
        console.warn(
          `[query] ${identity.pgRole} could not get a connection: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        throw new ServiceError(
          'too_many_queries',
          'No database connection was free. Usually one of your own queries is still ' +
            'running; if not, the server is refusing connections.',
        );
      }

      const startedAt = Date.now();
      let outcome: QueryOutcome;
      let disposition: ReturnType<ReturnType<Watchdog['arm']>['disarm']> = { signalled: false };

      try {
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const pid = rows[0]?.pid;
        if (pid === undefined) throw new Error('Postgres did not report a backend pid.');

        if (context) {
          // `<workspace>, public` — and deliberately **without** `"$user"`.
          //
          // An unqualified `DELETE FROM kunden` typed while working on an
          // exercise must not be able to reach the `kunden` in the student's own
          // playground; that is what makes "reset this exercise only" an honest
          // promise rather than a hopeful one. Their playground is still there
          // and still theirs — it just has to be named.
          //
          // `set_config` rather than `SET`, because `SET` takes no bind
          // parameter and this file is not one of the two allowed to build SQL
          // by string. The schema comes from `exercise_workspace` either way,
          // never from the request body.
          await client.query(`SELECT set_config('search_path', $1, false)`, [
            `${context.schema}, public`,
          ]);
        }

        const armed = watchdog.arm({
          userId,
          pgRole: identity.pgRole,
          pid,
          timeoutMs: config.limits.queryTimeoutMs,
        });

        try {
          const statements = await execute(
            client,
            sql,
            config.limits.maxResultRows,
            config.limits.maxResultBytes,
          );
          outcome = { ok: true, statements, durationMs: Date.now() - startedAt };
        } catch (err) {
          const error = toQueryError(err);
          outcome = { ok: false, statements: [], durationMs: Date.now() - startedAt, error };
        } finally {
          disposition = armed.disarm();
        }

        if (!outcome.ok && outcome.error?.code === QUERY_CANCELED) {
          // 57014 covers both "we cancelled it" and "the role's own
          // statement_timeout fired". The student sees the same thing either
          // way; only the reason differs, and the watchdog is the only one who
          // knows which happened.
          outcome.cancelled = {
            reason: disposition.signalled ? disposition.reason : 'timeout',
          };
        }
      } finally {
        if (disposition.signalled && disposition.terminated) {
          // The backend ignored the cancel and was killed. The connection is
          // gone; returning it to the pool would hand the corpse to the next
          // request.
          client.release(true);
        } else {
          // A cancelled statement inside an explicit transaction leaves the
          // session in 25P02 ("current transaction is aborted"), and a plain
          // `BEGIN;` with no COMMIT leaves it idle in one. Either state would be
          // inherited by whoever gets this connection next — including a
          // different request from the same student.
          //
          // This does mean a transaction cannot span two executions. That was
          // never actually true: a pool hands out whichever connection is free,
          // so `BEGIN;` in one request and `COMMIT;` in the next only ever
          // worked by luck. Consistently not working beats intermittently
          // working, and `idle_in_transaction_session_timeout` is the backstop
          // for the case where we crash before getting here.
          await client.query('ROLLBACK').catch(() => {});
          // Beside the ROLLBACK and for the same reason `provision.ts`'s
          // `asRole` resets: node-postgres does not issue `DISCARD ALL` on
          // release, so a `search_path` left set here would be inherited by
          // whatever takes this connection next — including this student's own
          // next query, run from their playground tab.
          //
          // Unconditional rather than `if (context)`. It costs one round trip on
          // a connection we are already holding, and the version that only
          // resets what it set is the version that stops resetting the moment
          // somebody adds a second caller that forgets to say so.
          await client.query('RESET search_path').catch(() => {});
          client.release();
        }
      }

      await logQuery(userId, sql, outcome, context);
      return outcome;
    },

    cancel(userId) {
      return watchdog.cancelUser(userId, 'user');
    },
  };
}
