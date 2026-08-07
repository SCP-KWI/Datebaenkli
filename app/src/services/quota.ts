/**
 * The per-student disk quota — the last safety rail from ARCHITECTURE §3.
 *
 * Postgres has no per-schema quota and cannot be made to have one. Everything
 * else in §3's table is enforced by the database (`CONNECTION LIMIT`,
 * `temp_file_limit`, `work_mem`, every grant); this one is enforced by us, and
 * the difference is worth being explicit about because it changes what the
 * guarantee is worth.
 *
 * ## What this actually promises
 *
 * It bounds the **steady state**, not a single statement. A student at 49 MB
 * can run one `INSERT … SELECT` that writes gigabytes; what stops *that* is the
 * watchdog's wall clock (20 s) and `temp_file_limit`. What this stops is the
 * accumulation: once they are over, the next thing that could grow the schema
 * is refused, and stays refused until they delete something.
 *
 * That is the honest shape of the control, and it is the useful one. The
 * failure this exists to prevent is a class of thirty leaving 300 MB of
 * `generate_series` experiments behind for the rest of term, not an adversary
 * with a 20-second budget.
 *
 * ## Why there is no background job
 *
 * §3 specified "a 5-minute background job sums `pg_total_relation_size` per
 * schema". Measured on demand instead, for one schema at a time. A cached
 * number is wrong for up to five minutes in the direction that matters — a
 * student can be 400 MB over and still be told they are fine — and the query it
 * would save is one indexed catalog scan plus a `stat()` per relation, which is
 * cheaper than the identity lookup the same request already does. There is
 * nothing to schedule, nothing to invalidate, and no window in which the answer
 * is stale.
 *
 * `mayGrow()` is what keeps that affordable: a script with no growing keyword
 * in it never asks the database anything at all.
 *
 * ## Why `pg_class`, not `information_schema`
 *
 * This runs on the **admin** handle, as `dbk_app`, about a *student's* schema —
 * exactly the shape that HANDOFF §4o is a warning about. `information_schema`
 * answers for `current_user`, and `dbk_app` holds student roles NOINHERIT, so
 * it would report every student as using zero bytes and the quota would never
 * fire. `pg_namespace`, `pg_class` and `pg_total_relation_size()` are
 * world-readable and answer truthfully for anybody.
 */

import type { Queryable } from '../db/query.js';
import { ServiceError } from './users.js';

/** Bytes a row costs beyond its values: 23-byte tuple header, aligned, plus the line pointer. */
const TUPLE_OVERHEAD = 28;

export interface QuotaUsage {
  bytes: number;
  quotaBytes: number;
  overQuota: boolean;
}

export interface QuotaGuard {
  /**
   * What this account currently occupies, measured now.
   *
   * The argument is a *role*, not a schema, and since phase 9 that distinction
   * is load-bearing: a student owns their playground schema plus one schema per
   * exercise they have opened, and all of it is on the same disk. Measuring only
   * the schema named after them would make the limit apply to half of what they
   * hold, with the unmeasured half growing every time a teacher hands out an
   * exercise.
   */
  usage(pgRole: string): Promise<QuotaUsage>;
  /**
   * What one table occupies, or 0 if there is no such table.
   *
   * Exists for the re-import: "replace" drops the old table inside the same
   * transaction, so its bytes are about to come back. Without this, a student
   * near the limit who fixes a typo in a 40 MB file and uploads it again is
   * refused for the space the *old* copy is holding — the one refusal in this
   * whole feature that would be plainly, visibly wrong.
   */
  relationBytes(schema: string, table: string): Promise<number>;
  /**
   * Refuse if the account is already over, or if `addingBytes` would take it
   * over. Throws `ServiceError('quota_exceeded')`; returns nothing otherwise.
   */
  check(pgRole: string, addingBytes?: number): Promise<void>;
  readonly quotaBytes: number;
}

/**
 * Statements that can make a schema bigger, as bare words.
 *
 * Deliberately a **deny**-list, which is the opposite of `db/ident.ts`'s
 * allow-list, and the difference is the consequence of being wrong. There, a
 * name that slips through becomes privileged SQL. Here, a keyword that slips
 * through means one write goes unmeasured — after which the schema is bigger,
 * the *next* check sees it, and the student is refused anyway. The control
 * self-corrects; a missed entry costs one statement, not a boundary.
 *
 * So the list only has to catch the ordinary ways a student adds data, and it
 * errs toward over-matching everywhere it is unsure:
 *
 *   - `into` catches `SELECT … INTO neu`, which creates a table while starting
 *     with the one keyword everybody would put on a read-only list.
 *   - `explain` is here because `EXPLAIN ANALYZE INSERT …` really does insert.
 *   - `update` because MVCC writes a new tuple version for every row touched,
 *     so a whole-table `UPDATE` roughly doubles the heap until it is vacuumed.
 *   - `do`, `call`, `execute` because none of them say what they will run.
 *
 * The `lo_*` entries are the odd ones out: they are function names, not
 * keywords, and they are here because a large object is the one way to grow a
 * student's footprint without writing a single SQL keyword.
 * `SELECT lo_from_bytea(0, repeat('a',100000000)::bytea)` matched nothing on
 * this list, so no quota check was even attempted — and the bytes it wrote were
 * invisible to `schemaUsage` too, until that learned to count them. `lo_unlink`
 * is deliberately absent for the same reason `delete` and `drop` are: it is the
 * way back out.
 *
 * `delete`, `drop`, `truncate` and `vacuum` are absent on purpose. They are the
 * way *out* of being over quota, and a student who cannot run them has no
 * recovery short of wiping their whole schema. `vacuum` especially: `VACUUM
 * FULL` is the only thing that turns a `DELETE` into free space, so a list that
 * refused it would leave a student who deleted everything still locked out.
 */
const GROWING =
  /\b(?:insert|update|create|alter|copy|merge|into|refresh|import|prepare|execute|do|call|explain|lo_from_bytea|lo_creat|lo_create|lo_put|lo_import|lo_open)\b/i;

/**
 * Strip SQL comments in one pass, honouring the fact that Postgres block
 * comments nest.
 *
 * **This was a regex and the regex was a remote denial of service.** The strip
 * used to be `/\/\*[\s\S]*?\*\//g`, and every unterminated `/*` restarts that
 * scan at end-of-string: `"/*" + "/*x".repeat(33000)` — comfortably inside
 * `MAX_SQL_LENGTH` — took 792 ms of *synchronous* CPU, measured. `mayGrow` runs
 * on every `POST /api/query` before a pool connection is taken, so none of the
 * usual rails apply: not `statement_timeout`, not the watchdog, not
 * `CONNECTION LIMIT`. A student in a loop froze the whole school's server.
 *
 * `i` advances by at least one on every branch, so this is O(n) by inspection.
 * Handling the nesting properly is a side benefit — the old comment
 * acknowledged the regex got it wrong and argued the error was in the safe
 * direction, which was true but is now moot.
 *
 * String literals are deliberately *not* tracked; see `mayGrow`.
 */
function stripComments(sql: string): { text: string; unterminated: boolean } {
  const kept: string[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;

  while (i < sql.length) {
    if (depth === 0) {
      if (sql.charCodeAt(i) === 45 /* - */ && sql.charCodeAt(i + 1) === 45) {
        kept.push(sql.slice(start, i));
        const nl = sql.indexOf('\n', i + 2);
        if (nl === -1) return { text: kept.join(' '), unterminated: false };
        // Resume *at* the newline so the line break survives into `text`.
        i = nl;
        start = i;
        continue;
      }
      if (sql.charCodeAt(i) === 47 /* / */ && sql.charCodeAt(i + 1) === 42 /* * */) {
        kept.push(sql.slice(start, i));
        depth = 1;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // Inside a block comment only the two nesting markers matter.
    if (sql.charCodeAt(i) === 47 && sql.charCodeAt(i + 1) === 42) {
      depth++;
      i += 2;
      continue;
    }
    if (sql.charCodeAt(i) === 42 && sql.charCodeAt(i + 1) === 47) {
      depth--;
      i += 2;
      if (depth === 0) start = i;
      continue;
    }
    i++;
  }

  if (depth > 0) return { text: '', unterminated: true };
  kept.push(sql.slice(start));
  return { text: kept.join(' '), unterminated: false };
}

/**
 * Could this script make the schema bigger?
 *
 * A keyword scan, not a parse. `libpg-query` would answer exactly and is
 * already in the repo — as a *dev* dependency, for `test/sql.test.mjs`, and
 * promoting it to the runtime would be the fifth production dependency for a
 * question whose wrong answers both cost one statement (see `GROWING`).
 *
 * Comments are stripped first, because `-- create a table` is a perfectly
 * ordinary thing to have above a `SELECT` and refusing it would be baffling.
 * String literals are **not** stripped: `WHERE name = 'Insert'` will
 * over-refuse. That is the safe direction, it costs a student who is already
 * over quota one confusing refusal, and the alternative is hand-rolling a
 * lexer that has to know about dollar quoting and escape strings to be right.
 */
export function mayGrow(sql: string): boolean {
  const { text, unterminated } = stripComments(sql);
  // An unterminated block comment cannot execute at all — Postgres rejects the
  // statement — but scanning the raw text keeps the bias this whole function is
  // built on: when unsure, answer "yes" and make the student's write prove
  // itself against the real quota check.
  return GROWING.test(unterminated ? sql : text);
}

/**
 * What an import is about to add, near enough to refuse on.
 *
 * An estimate, and it does not try to be more: real cost depends on alignment,
 * padding, TOAST compression and the width of every index the student adds
 * later. Value length in UTF-16 units rather than bytes for the same reason —
 * `Buffer.byteLength` per cell over 100 000 rows to sharpen a number that is
 * approximate anyway.
 *
 * Being wrong is cheap in both directions. Too low lets one import land that
 * takes the schema over, and the next check refuses everything after it. Too
 * high refuses an import that would have just fit, and the student deletes
 * something. Neither is worth a byte-accurate answer.
 */
export function estimateImportBytes(values: readonly (string | null)[][]): number {
  let bytes = 0;
  for (const row of values) {
    bytes += TUPLE_OVERHEAD;
    for (const value of row) bytes += value === null ? 0 : value.length;
  }
  return bytes;
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * `teachDb` is the admin handle on the teaching database — sizes live there,
 * not in `datebaenkli_meta`. Taken as a parameter rather than imported, like
 * every other service, so the live suite can point one at a real cluster with a
 * one-byte quota instead of filling 50 MB to see the refusal.
 */
export function makeQuotaGuard(teachDb: Queryable, quotaBytes: number): QuotaGuard {
  // A local function rather than `this.usage` inside `check`: these get
  // destructured out of the deps object at the top of every service that takes
  // one, and a method that needs its receiver would break the moment somebody
  // wrote `const { check } = quota`.
  const usage = async (pgRole: string): Promise<QuotaUsage> => {
    // The role name is a bind parameter, so this file is not a third one that
    // concatenates SQL (CLAUDE.md). `LEFT JOIN` to `pg_class` rather than
    // driving from it for the same reason the catalog does (HANDOFF §4i): an
    // empty schema must still produce a row, or a student with no tables reads
    // as "schema missing" instead of "0 bytes". Here there is no GROUP BY at
    // all, so the aggregate over no rows is one row of NULL, coalesced to 0 —
    // the same answer, and it survives an account that owns nothing yet.
    //
    // **Two conditions, and they are not redundant.** `r.rolname = $1` is the
    // one that matters — it collects the playground *and* every exercise
    // workspace in one round trip, without this having to be told which
    // workspaces exist, and it keeps counting one whose meta row was deleted.
    // `n.nspname = $1` is the safety net underneath it: a schema named after
    // this student but owned by somebody else is a broken state nothing else
    // checks for, and the direction to be wrong in is over-counting.
    const { rows } = await teachDb.query<{ bytes: string }>(
      `SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::text AS bytes
         FROM pg_namespace n
         LEFT JOIN pg_roles r ON r.oid = n.nspowner
         LEFT JOIN pg_class c
           ON c.relnamespace = n.oid AND c.relkind IN ('r', 'm', 'p')
        WHERE n.nspname = $1 OR r.rolname = $1`,
      [pgRole],
    );
    const bytes = Number(rows[0]?.bytes ?? 0);
    return { bytes, quotaBytes, overQuota: bytes > quotaBytes };
  };

  const relationBytes = async (schema: string, table: string): Promise<number> => {
    const { rows } = await teachDb.query<{ bytes: string }>(
      `SELECT pg_total_relation_size(c.oid)::text AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'm', 'p')`,
      [schema, table],
    );
    return Number(rows[0]?.bytes ?? 0);
  };

  const check = async (pgRole: string, addingBytes = 0): Promise<void> => {
    const { bytes } = await usage(pgRole);
    if (bytes + addingBytes <= quotaBytes) return;

    // The numbers are in the message on purpose. "Quota exceeded" tells a
    // student nothing they can act on; "your database holds 63.4 MB of 50.0 MB"
    // tells them roughly how much has to go, and the sentence after it says
    // what removes it. This is the one 4xx in the app a student is expected to
    // hit while doing nothing wrong, so it is the one that has to teach.
    //
    // And it must name `DROP TABLE` and `TRUNCATE` rather than `DELETE`.
    // `DELETE` frees **nothing**: the dead tuples stay in the heap until
    // `VACUUM FULL` rewrites it, so `pg_total_relation_size` does not move.
    // Found by driving this over HTTP — deleting 39 900 of 40 000 rows left the
    // schema at exactly the 4.0 MB it started at, and a student following the
    // first draft of this sentence would have deleted all their data and still
    // been refused. `DELETE` is still *allowed* (see `GROWING`); it is just not
    // the advice.
    throw new ServiceError(
      'quota_exceeded',
      addingBytes > 0
        ? `Your database holds ${mb(bytes)} and this import would add about ` +
            `${mb(addingBytes)}, over your limit of ${mb(quotaBytes)}. ` +
            `Drop a table you no longer need (DROP TABLE …) and try again.`
        : `Your database holds ${mb(bytes)}, over your limit of ${mb(quotaBytes)}. ` +
            `Free space with DROP TABLE or TRUNCATE — DELETE on its own does not, ` +
            `because the deleted rows stay on disk until VACUUM FULL. Nothing new ` +
            `can be written until you are back under.`,
    );
  };

  return { quotaBytes, usage, relationBytes, check };
}
