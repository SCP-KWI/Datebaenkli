/**
 * The cancellation watchdog — phase 3.
 *
 * `statement_timeout` is not a security boundary (HANDOFF §4, ARCHITECTURE §3):
 * it is `USERSET`, so a student can run `SET statement_timeout = 0` in the
 * editor, or persist `ALTER ROLE <self> SET statement_timeout = '1h'`, and
 * Postgres offers no way to forbid either. The role default stays because it
 * catches the realistic case — an accidental cartesian join — without a round
 * trip. This file is what makes the limit actually hold.
 *
 * Every in-flight statement is registered here with the backend pid running it.
 * A wall-clock timer cancels anything past its deadline, and the same primitive
 * backs the UI's Cancel button. Both go out from the `dbk_app` pool, which the
 * student has no way to reach.
 *
 * ## Two findings this file is shaped around, both verified live
 *
 * **1. `dbk_app` cannot cancel a student's backend directly.** `pg_signal_backend`
 * checks `has_privs_of_role()`, which respects `INHERIT` — and provisioning
 * grants student roles to `dbk_app` `WITH INHERIT FALSE` (provision.ts, and the
 * same trap that made a teacher's grant have to be issued *by the student*). A
 * plain `SELECT pg_cancel_backend($1)` from the admin pool fails with 42501,
 * "permission denied to cancel query". A watchdog built the obvious way would
 * therefore have shipped never having cancelled anything, and nothing in a
 * PGlite test could have caught it. We step into the role first — the grant
 * carries `SET TRUE` precisely so this is possible.
 *
 * **2. It steps in with `set_config`, not `SET ROLE`.** `SET ROLE` takes no bind
 * parameter and would mean concatenating a role name into SQL, which CLAUDE.md
 * confines to provision.ts. `set_config('role', $1, true)` is the same GUC
 * through a `$1` placeholder, and its third argument makes it `SET LOCAL`, so
 * the admin connection unwinds back to `dbk_app` at COMMIT instead of returning
 * to the pool wearing a student's identity. That is also why the signal runs in
 * a transaction it does not otherwise need.
 *
 * Stepping into the role has a second, free benefit: Postgres then refuses to
 * signal a backend that is not that student's, so a pid recycled between our
 * reading it and our using it cannot take out somebody else's query.
 */

import type { Db } from '../db/query.js';

/** Why a query was stopped. Reported to the student, and written to `query_log`. */
export type CancelReason = 'timeout' | 'user';

export interface ArmSpec {
  userId: number;
  /** The role the backend is running as — we must become it to signal it. */
  pgRole: string;
  pid: number;
  /** Wall-clock budget. Past this the watchdog cancels. */
  timeoutMs: number;
}

/**
 * What happened to a query while it was armed.
 *
 * `terminated` is the field the caller cannot ignore: a cancelled backend is
 * still usable and goes back to the pool, a terminated one is dead and must be
 * destroyed instead.
 */
export type Disposition =
  | { signalled: false }
  | { signalled: true; reason: CancelReason; terminated: boolean };

export interface ArmedQuery {
  readonly id: string;
  /** Stop the timers and report. Must be called in a `finally`. */
  disarm(): Disposition;
}

export interface ActiveQuery {
  id: string;
  userId: number;
  pgRole: string;
  pid: number;
  startedAt: Date;
  signalled: CancelReason | null;
}

export interface Watchdog {
  arm(spec: ArmSpec): ArmedQuery;
  /**
   * Stop everything `userId` is running. Returns how many backends were
   * signalled — 0 when the query finished between the click and the request,
   * which is a normal race and not an error.
   */
  cancelUser(userId: number, reason?: CancelReason): Promise<number>;
  /** Snapshot, for /health and the phase-4 live lesson view. */
  active(): ActiveQuery[];
}

interface Log {
  warn(msg: string): void;
  error(msg: string): void;
}

interface Entry extends ArmSpec {
  id: string;
  startedAt: number;
  deadline: NodeJS.Timeout;
  escalation?: NodeJS.Timeout;
  signalled: CancelReason | null;
  terminated: boolean;
  /**
   * Set by `disarm()`. `clearTimeout` alone is not enough to stop the
   * escalation: see `fire()`.
   */
  done: boolean;
}

/**
 * How long a cancelled backend gets to notice before we terminate it.
 *
 * `pg_cancel_backend` is a request, not a guarantee: it sets a flag the backend
 * checks at interrupt points, and a statement stuck below one — some loops in C
 * functions, a wedged network write — never sees it. Termination always works
 * because it closes the socket, but it destroys the session, so it is the
 * second thing we try rather than the first.
 */
const DEFAULT_ESCALATION_MS = 3_000;

export function makeWatchdog(
  teachDb: Db,
  log: Log = console,
  escalationMs: number = DEFAULT_ESCALATION_MS,
): Watchdog {
  const active = new Map<string, Entry>();
  let seq = 0;

  /**
   * Send one signal as the student.
   *
   * Returns false for "the backend is not there any more", which is the common
   * outcome of a race with normal completion and not worth logging. A genuine
   * failure is logged and swallowed: nothing here may reject, because every
   * caller is a timer callback or a `finally`.
   */
  async function signal(entry: Entry, fn: 'pg_cancel_backend' | 'pg_terminate_backend') {
    try {
      return await teachDb.tx(async (q) => {
        // SET LOCAL ROLE, by bind parameter. See the header — this is the whole
        // reason the watchdog can reach a student's backend at all.
        await q.query('SELECT set_config($1, $2, true)', ['role', entry.pgRole]);
        const { rows } = await q.query<{ ok: boolean | null }>(
          `SELECT ${fn}($1) AS ok`, // fn is one of two literals above, never input
          [entry.pid],
        );
        return rows[0]?.ok === true;
      });
    } catch (err) {
      log.error(
        `[watchdog] ${fn}(${entry.pid}) for ${entry.pgRole} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }

  async function fire(entry: Entry, reason: CancelReason): Promise<boolean> {
    if (entry.done) return false; // finished between the snapshot and here
    if (entry.signalled !== null) return false; // already stopping; don't signal twice
    entry.signalled = reason;
    clearTimeout(entry.deadline);

    const cancelled = await signal(entry, 'pg_cancel_backend');

    // The cancel we just sent is very often what ends the query, so by now the
    // runner may already have disarmed — and it disarmed against an escalation
    // timer that did not exist yet. Arming one now would leave a timer nothing
    // can cancel, which fires later and terminates whatever that pid has become
    // by then: in a pool, an idle connection belonging to the student's *next*
    // query. That is the bug this flag exists for; `clearTimeout` cannot fix it
    // because the ordering, not the handle, is the problem.
    if (entry.done) return cancelled;

    // Otherwise arm it, even when the cancel reported false: false can mean
    // "already gone", but it can also mean the signal did not land, and the
    // difference is not observable from here.
    entry.escalation = setTimeout(() => {
      void (async () => {
        // Re-checked because a timer whose callback is already queued does not
        // un-queue when `disarm()` clears it.
        if (entry.done) return;
        entry.terminated = await signal(entry, 'pg_terminate_backend');
        if (entry.terminated) {
          log.warn(
            `[watchdog] ${entry.pgRole} pid ${entry.pid} ignored a cancel; terminated after ` +
              `${escalationMs}ms (reason: ${reason})`,
          );
        }
      })();
    }, escalationMs);
    entry.escalation.unref();

    return cancelled;
  }

  return {
    arm(spec) {
      const id = String(++seq);
      const entry: Entry = {
        ...spec,
        id,
        startedAt: Date.now(),
        signalled: null,
        terminated: false,
        done: false,
        deadline: setTimeout(() => void fire(entry, 'timeout'), spec.timeoutMs),
      };
      // A pending deadline must not hold the process open during shutdown; the
      // query it belongs to is awaited by a request that Fastify drains first.
      entry.deadline.unref();
      active.set(id, entry);

      return {
        id,
        disarm() {
          entry.done = true;
          clearTimeout(entry.deadline);
          clearTimeout(entry.escalation);
          active.delete(id);
          return entry.signalled === null
            ? { signalled: false }
            : { signalled: true, reason: entry.signalled, terminated: entry.terminated };
        },
      };
    },

    async cancelUser(userId, reason = 'user') {
      // Snapshot first: `fire` awaits, and an entry can disarm underneath us.
      const mine = [...active.values()].filter((e) => e.userId === userId);
      const results = await Promise.all(mine.map((e) => fire(e, reason)));
      return results.filter(Boolean).length;
    },

    active() {
      return [...active.values()].map((e) => ({
        id: e.id,
        userId: e.userId,
        pgRole: e.pgRole,
        pid: e.pid,
        startedAt: new Date(e.startedAt),
        signalled: e.signalled,
      }));
    },
  };
}
