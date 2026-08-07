/**
 * The nightly `active -> archived` sweep — phase 5b, architecture §8b.
 *
 * **Why this is in the app process and not in the host crontab beside
 * `db/backup.sh`.** It is application semantics from end to end: the
 * `user_state` machine, `destroyUserSessions`, the `audit_log` contract, the
 * teacher grants that `setUserState` puts back on the way out. A bash job would
 * have to reimplement `setUserState` in SQL against the meta database and would
 * own a second, silently diverging copy of what archiving means — and since
 * there is no node on the server (HANDOFF §7) it would end up as
 * `docker exec … node` regardless, which is this code with an extra scheduling
 * surface. `backup.sh` is outside the app on purpose, because it must work when
 * the app is broken (§4y); this is the exact opposite requirement.
 *
 * What makes that safe is that the scheduled half is **non-destructive**.
 * Archiving takes a login away and leaves every table where it was, and one
 * click puts it back. The destructive half of the lifecycle — `cold`, which
 * dumps and drops — is admin-triggered per §8b and has no scheduler at all.
 *
 * **Idle is measured from `coalesce(last_active_at, created_at)`.**
 * `last_active_at` is written on login and by the query runner, deliberately
 * not on every request (`auth/session.ts`), so it means "last did something",
 * which is the right notion. It is NULL for an account that has never logged
 * in — a student holding an unused credential slip — and comparing NULL would
 * quietly exclude exactly the accounts a year-old unclaimed slip describes.
 * `created_at` is the honest floor for those.
 */

import { config } from '../config.js';
import type { Db } from '../db/query.js';
import { audit } from './audit.js';
import type { Provisioner } from './provision.js';
import { setUserState } from './users.js';

export interface SweepCandidate {
  id: number;
  username: string;
  pgRole: string;
  /** Days since `coalesce(last_active_at, created_at)`, for the log line. */
  idleDays: number;
}

export interface SweepReport {
  /** How many active students were past the threshold when the pass started. */
  considered: number;
  archived: SweepCandidate[];
  /** Archived in the meta database, but the teaching database did not follow. */
  failed: { pgRole: string; error: string }[];
}

/**
 * Archive every student idle past `archiveAfterDays`.
 *
 * `actorId` is null for the scheduled pass — nobody pressed anything — and the
 * admin's id when it arrives over HTTP, the same convention as `reconcile`.
 *
 * Sequential, not `Promise.all`, for the reason `createStudents` gives: each
 * account is a short meta transaction plus a teaching-database round trip, they
 * would queue on the five-connection admin pool anyway, and the audit trail of
 * a partial failure is far easier to read in order. A year's worth of idle
 * accounts is a class or two, not a stampede.
 */
export async function sweepInactiveStudents(
  db: Db,
  prov: Provisioner,
  actorId: number | null = null,
): Promise<SweepReport> {
  const report: SweepReport = { considered: 0, archived: [], failed: [] };

  const { rows: candidates } = await db.query<SweepCandidate>(
    // `role = 'student'` on purpose. A teacher going NOLOGIN frees nothing —
    // their playground schema is not what fills a disk — and would lock out
    // someone returning from a sabbatical in the middle of a school year, with
    // their whole class's grants hanging off an account nobody thought about.
    // Architecture §8b describes archival in terms of students throughout.
    //
    // `make_interval(days => $1)` rather than string-building an interval: this
    // number comes from the environment, and although `config.ts` has already
    // proved it is an integer, a query that would still be safe if it had not
    // is the one to write.
    `SELECT id, username, pg_role AS "pgRole",
            (extract(epoch FROM now() - coalesce(last_active_at, created_at)) / 86400)::int
              AS "idleDays"
       FROM app_user
      WHERE role = 'student'
        AND state = 'active'
        AND pg_role IS NOT NULL
        -- An account whose work is in a file is not one to archive. It gets
        -- here when a cold-to-active restore failed and left the row saying
        -- active with the dump still named; archiving it would produce a row
        -- claiming "schema kept, one click back" over an account with no
        -- schema. setUserState refuses that outright (restore_first), so
        -- without this line the sweep would throw on it every night.
        AND archive_path IS NULL
        AND coalesce(last_active_at, created_at) < now() - make_interval(days => $1::int)
      ORDER BY id`,
    [config.lifecycle.archiveAfterDays],
  );
  report.considered = candidates.length;
  if (candidates.length === 0) return report;

  for (const candidate of candidates) {
    // Each account in its own try, because `setUserState` *throws* for a whole
    // class of ordinary races that the `provisioning` field does not cover. The
    // candidate list is a plain SELECT, not a lock: between it and this line a
    // teacher can delete a student (the UPDATE matches no row and it throws
    // `user_not_found`) or an admin can cold-store one (`restore_first`).
    // Letting that escape would abandon every candidate after it until tomorrow
    // *and* skip the summary audit row for the ones already archived — a sweep
    // that did half its work and reported none of it.
    try {
      // The real `setUserState`, not a bespoke UPDATE. That is the entire
      // argument for running in-process: the sessions get destroyed, the role
      // goes NOLOGIN, the `user_state_changed` row is written, and none of it
      // can drift from what the roster's own Archivieren button does.
      const { provisioning } = await setUserState(
        db,
        prov,
        actorId,
        candidate.id,
        'archived',
        'sweep',
      );
      if (provisioning.ok) report.archived.push(candidate);
      else report.failed.push({ pgRole: candidate.pgRole, error: provisioning.error ?? 'unknown' });
    } catch (err) {
      report.failed.push({
        pgRole: candidate.pgRole,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (report.archived.length > 0 || report.failed.length > 0) {
    // One summary row on top of the per-account ones. §8b asks that archival
    // never be silent and suggests mail; there is no mail path here and adding
    // one is a fifth runtime dependency. What the roster already does covers
    // most of it — a non-active student renders as a `tag warn` with an
    // "Aktivieren" button beside it (`web/assets/roster.js`) — and this row is
    // the missing half: it answers *why*, and on which night, for the whole
    // batch at once rather than one account at a time.
    await audit(db, {
      actorId,
      action: 'archive_swept',
      detail: {
        afterDays: config.lifecycle.archiveAfterDays,
        archived: report.archived.map((c) => c.username),
        failed: report.failed,
      },
    });
  }

  return report;
}

export function summariseSweep(r: SweepReport): string {
  return (
    `archive sweep: ${String(r.considered)} students idle past ` +
    `${String(config.lifecycle.archiveAfterDays)} days, ` +
    `${String(r.archived.length)} archived, ${String(r.failed.length)} failed`
  );
}

// --- the schedule ------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;

/**
 * Milliseconds until the next local `sweepHour:sweepMinute`.
 *
 * Recomputed from a fresh `Date` on every arm rather than being a fixed 24 h
 * interval, and the difference is not pedantry:
 *
 *   - `setInterval(24 h)` fires relative to *boot*, so the sweep drifts to
 *     whenever the container last restarted — which is the middle of a school
 *     day as often as not.
 *   - Recomputing also makes the DST transitions right for free. Local
 *     midnight-to-midnight is 23 or 25 hours twice a year in Zurich, and
 *     `setHours` on a fresh date resolves to the correct instant either way.
 *
 * The hour matters because of one race. A student logging in updates
 * `last_active_at`, so the sweep will not touch them — but a sweep running at
 * 14:00 can read a stale row a second before that login lands, archive the
 * account, and destroy the session they just created. Reversible in a click,
 * and avoidable entirely by running it when nobody is in a lesson.
 */
export function msUntilNextSweep(now: Date): number {
  const next = new Date(now);
  next.setHours(config.lifecycle.sweepHour, config.lifecycle.sweepMinute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Arm the nightly sweep. A no-op when it is already armed or turned off.
 *
 * Note what it does *not* do: run once at startup. Every other sweeper here
 * does, because theirs are cheap and invisible (expired sessions, rate-limit
 * buckets). This one takes accounts away from students, and running it on boot
 * would mean every deploy — which happens during the day — fires it at exactly
 * the wrong moment, for no gain: a sweep missed because the container was down
 * at 03:40 is a sweep that happens at 03:40 tomorrow, and the accounts in
 * question have been idle for a year.
 */
export function startArchiveSweeper(
  db: Db,
  prov: Provisioner,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  if (timer !== undefined) return;
  if (!config.lifecycle.sweepEnabled) {
    log.info('archive sweep is disabled (DBK_ARCHIVE_SWEEP=false)');
    return;
  }

  const arm = (): void => {
    const delay = msUntilNextSweep(new Date());
    timer = setTimeout(() => {
      void sweepInactiveStudents(db, prov)
        .then((report) => {
          // Quiet on a night that archived nobody, which is almost every night.
          // A log line per uneventful sweep trains a reader to skip the ones
          // that are not.
          if (report.archived.length > 0 || report.failed.length > 0) {
            log.warn(summariseSweep(report));
            for (const f of report.failed) log.warn(`archive sweep: ${f.pgRole}: ${f.error}`);
          }
        })
        .catch((err: unknown) => {
          log.warn(`archive sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        // Re-arm whatever happened. A sweep that throws must not be the last
        // one this container ever runs.
        .finally(arm);
    }, delay);
    timer.unref();
  };

  arm();
  /**
   * Names the zone it actually resolved, rather than saying "local".
   *
   * `setHours` works in the *process* zone, and the container sets no `TZ` at
   * all, so that zone is UTC and the sweep fires at 03:40 UTC — 05:40 in Zurich
   * for half the year and 04:40 for the other half (§4gg). The line used to say
   * "local", which a reader in Switzerland reads as Swiss time, and it was wrong
   * in a way no amount of staring at the log would reveal.
   *
   * Printing `resolvedOptions().timeZone` rather than picking a wording is the
   * point: it is true under any `TZ`, it needs no decision about what the
   * container's zone *should* be, and it makes that decision visible to whoever
   * takes it — the answer is now in the boot log rather than in §4gg.
   */
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  log.info(
    `archive sweep armed for ${String(config.lifecycle.sweepHour).padStart(2, '0')}:` +
      `${String(config.lifecycle.sweepMinute).padStart(2, '0')} ${zone}, ` +
      `threshold ${String(config.lifecycle.archiveAfterDays)} days`,
  );
}

export function stopArchiveSweeper(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}
