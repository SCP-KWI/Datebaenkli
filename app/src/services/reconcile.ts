/**
 * Make the teaching database match `app_user`.
 *
 * This is the counterweight to provisioning happening outside the meta
 * transaction. Every seam in `users.ts` and `classes.ts` can fail *after* its
 * account row is committed — the network drops, the teaching database is
 * restarting, the archive volume is not mounted — and none of them are allowed
 * to fail the request when that happens. What makes that acceptable is that the
 * gap is always detectable: `app_user` says what should exist, `pg_roles` and
 * `pg_namespace` say what does, and the difference is repairable from the
 * account row alone.
 *
 * There is deliberately no `provisioned_at` column to consult (HANDOFF §7).
 * A flag would be a second source of truth about the state of the database, and
 * the whole point of reconciling is that the database itself is the first one.
 *
 * It runs at startup and on demand. Both matter: the startup pass means a
 * restart repairs a crashed batch with no operator involved, and the on-demand
 * one means an operator who just fixed the archive mount does not have to
 * restart to act on it.
 */

import { config } from '../config.js';
import type { Db } from '../db/query.js';
import { audit } from './audit.js';
import { PUBLIC_GRANTEE, tryProvision, type Provisioner } from './provision.js';
import {
  pgIdentities,
  recordArchivePath,
  type AppRole,
  type PgIdentity,
  type UserState,
} from './users.js';

export interface ReconcileReport {
  checked: number;
  /** Roles (and their schemas) that did not exist and now do. */
  created: string[];
  /** Roles whose LOGIN flag disagreed with the account state. */
  loginFixed: string[];
  /**
   * Roles that existed, owned their schema, and could not connect to the
   * teaching database. In normal running this stays empty — `ensureRole` grants
   * CONNECT and nothing revokes it. It fills up after a restore, which is the
   * case it was added for: `pg_database.datacl` survives neither dump.
   */
  connectFixed: string[];
  /**
   * Roles whose `statement_timeout` / `work_mem` session rails were missing and
   * have been re-issued. Normally empty; it fills when a student has run
   * `ALTER ROLE ... RESET ALL` on themselves.
   */
  settingsFixed: string[];
  granted: { student: string; teacher: string }[];
  /**
   * `former_teacher` is a handover whose revoke did not run. `peer_student` is
   * one student having granted another access to their own schema, and `public`
   * is the same act done to everyone at once — see `reconcileGrants`. Anything
   * that is none of the three goes to `anomalies` rather than being revoked.
   */
  revoked: {
    student: string;
    grantee: string;
    reason: 'former_teacher' | 'peer_student' | 'public';
  }[];
  /** Deleted accounts whose schema was dumped and dropped on this pass. */
  dropped: string[];
  /**
   * Accounts whose schema was missing and whose dump was put back.
   *
   * Not the same event as `created`, and the distinction is the point. An
   * account with no schema and no dump never had one, so `ensure` is the whole
   * repair; an account with no schema and an `archive_path` has one *in a file*,
   * and creating an empty schema over it would leave the dump on disk with
   * nothing in the system referring to it. See the cold branch below.
   */
  restored: string[];
  /**
   * Things that are wrong and that this pass deliberately did not touch.
   *
   * Distinct from `failed`, which means a repair was attempted and errored.
   * These are states where the repair is *ambiguous*, and the only actions
   * available without knowing which case it is would destroy something: a cold
   * account that has a schema might be a hand-run `pg_restore` (the row is
   * wrong) or a `coldStore` that dumped and failed to drop (the drop should be
   * retried), and telling them apart from here is impossible. A repair tool
   * must not drop a schema on a guess, so it says so and stops.
   *
   * One list rather than a field per anomaly, because the previous shape needed
   * edits in four places to add one — and a forgotten `reportIsClean` line
   * makes the boot log say "nothing to repair" over an account holding a
   * schema nobody can explain.
   */
  anomalies: { pgRole: string; note: string }[];
  failed: { pgRole: string; step: string; error: string }[];
}

function emptyReport(): ReconcileReport {
  return {
    checked: 0,
    created: [],
    loginFixed: [],
    connectFixed: [],
    settingsFixed: [],
    granted: [],
    revoked: [],
    dropped: [],
    restored: [],
    anomalies: [],
    failed: [],
  };
}

export function reportIsClean(r: ReconcileReport): boolean {
  return (
    r.created.length === 0 &&
    r.loginFixed.length === 0 &&
    r.connectFixed.length === 0 &&
    r.settingsFixed.length === 0 &&
    r.granted.length === 0 &&
    r.revoked.length === 0 &&
    r.dropped.length === 0 &&
    r.restored.length === 0 &&
    r.anomalies.length === 0 &&
    r.failed.length === 0
  );
}

export function summarise(r: ReconcileReport): string {
  return (
    `reconcile: ${r.checked} accounts checked, ${r.created.length} provisioned, ` +
    `${r.loginFixed.length} login flags corrected, ` +
    `${r.connectFixed.length} database connect grants restored, ` +
    `${r.settingsFixed.length} role settings re-applied, ` +
    `${r.granted.length} grants added, ` +
    `${r.revoked.length} revoked, ${r.dropped.length} dropped, ` +
    `${r.restored.length} restored from cold storage, ` +
    `${r.anomalies.length} anomalies left for a human, ` +
    `${r.failed.length} failed`
  );
}

interface AccountRow {
  id: number;
  role: AppRole;
  state: UserState;
  pgRole: string;
}

/**
 * Reconcile every account with a Postgres identity.
 *
 * `actorId` is null for the startup pass — nobody pressed anything — and the
 * admin's id when it comes in over HTTP. It only affects the audit trail.
 */
export async function reconcile(
  db: Db,
  prov: Provisioner,
  actorId: number | null = null,
): Promise<ReconcileReport> {
  const report = emptyReport();
  if (!prov.live) return report;

  // Ordered so teachers are provisioned before the students who need a grant
  // to them: `app_role` is an enum declared admin, teacher, student, so plain
  // ORDER BY puts them in exactly that sequence.
  const { rows: accounts } = await db.query<AccountRow>(
    `SELECT id, role, state, pg_role AS "pgRole"
       FROM app_user
      WHERE pg_role IS NOT NULL
      ORDER BY role, id`,
  );
  report.checked = accounts.length;
  if (accounts.length === 0) return report;

  const inventory = await prov.inventory(accounts.map((a) => a.pgRole));
  const identities = new Map<number, PgIdentity>();
  for (const identity of await pgIdentities(db, accounts.map((a) => a.id))) {
    identities.set(identity.userId, identity);
  }

  const fail = (pgRole: string, step: string, error: string): void => {
    report.failed.push({ pgRole, step, error });
  };
  const anomaly = (pgRole: string, note: string): void => {
    report.anomalies.push({ pgRole, note });
  };

  for (const account of accounts) {
    const { pgRole } = account;
    const identity = identities.get(account.id);

    // --- deleted: retry the dump and drop -----------------------------------
    //
    // `setUserState` refuses to drop a schema whose archive dump failed, which
    // leaves exactly this: an account marked deleted whose role is still there.
    // That is the recoverable direction of the failure, and this is the retry.
    if (account.state === 'deleted') {
      if (!inventory.roles.has(pgRole)) continue;
      const outcome = await tryProvision(
        db,
        { actorId, userId: account.id, pgRole, step: 'archiveAndDrop' },
        () => prov.archiveAndDrop(pgRole),
      );
      if (outcome.ok) {
        report.dropped.push(pgRole);
        // The column too, not only the audit detail. Migration 002's argument is
        // that a trail is not an index, and it applies to a dump this pass took
        // exactly as much as to one `setUserState` took.
        if (outcome.archivePath) await recordArchivePath(db, account.id, outcome.archivePath);
        await audit(db, {
          actorId,
          action: 'user_deprovisioned',
          targetType: 'app_user',
          targetId: account.id,
          detail: { pgRole, archivePath: outcome.archivePath ?? null, via: 'reconcile' },
        });
      } else {
        fail(pgRole, 'archiveAndDrop', outcome.error ?? 'unknown');
      }
      continue;
    }

    // An account whose password cannot be decrypted (a changed
    // DBK_ENCRYPTION_KEY) surfaces here rather than taking the whole pass down.
    if (!identity) {
      fail(pgRole, 'identity', 'no readable Postgres identity for this account');
      continue;
    }

    const shouldLogin = account.state === 'active';
    const existing = inventory.roles.get(pgRole);
    const hasSchema = inventory.schemas.has(pgRole);

    // --- cold: the missing schema is the point ------------------------------
    //
    // This branch exists because its absence was a data-loss-shaped bug, and it
    // was in the tree before the first cold account could trigger it (§4dd).
    // The test below used to read "role missing OR schema missing -> provision
    // from scratch", and a cold account is *defined* by having a role and no
    // schema. It would therefore have been re-provisioned on the next boot with
    // a fresh empty schema, `archive_path` would have been left pointing at a
    // dump nothing would ever look at again, and the report would have called
    // it "created" — a repair tool destroying the thing it was repairing, and
    // saying so in the past tense.
    if (account.state === 'cold') {
      if (!existing) {
        anomaly(
          pgRole,
          identity.archivePath === null
            ? 'cold with neither a role nor a dump: nothing here can bring this account back'
            : 'cold, and the role is gone; reactivating the account restores the dump',
        );
        continue;
      }
      if (hasSchema) {
        anomaly(pgRole, 'cold, but the schema is still there — the drop or the row is wrong');
      }
      // Fall through to the login and CONNECT checks. Cold is NOLOGIN
      // (`shouldLogin` is false for every non-active state) and keeps CONNECT,
      // for the same reason archived does — see below. What it must skip is
      // `reconcileGrants`, which is handled at the bottom of the loop: there is
      // no schema to grant USAGE on, so every pass would fail identically.
    } else if (!existing || !hasSchema) {
      // --- missing entirely: provision from scratch, or put the dump back ---
      //
      // `archive_path` set with no schema is not "never provisioned", it is a
      // restore that did not finish — `setUserState` clears the column only
      // once `restoreStudent` has proved the student can read the tables again.
      // So this is the retry for that, exactly as the `deleted` branch above is
      // the retry for a dump that failed. Getting it wrong the other way is the
      // §4dd hazard once more: an empty schema over a dump nobody references.
      //
      // The test is the dump, and **not** also "the role survived". Requiring a
      // live role here was a real hole found in review: a student with a dump
      // whose role had also gone — a cluster rebuilt from a meta backup with
      // stale globals, or a hand-run `DROP ROLE` during triage — fell through to
      // `ensureStudent` and got a fresh empty schema over a term's work, filed
      // under `created`. `restoreStudent` calls `ensureStudentRole` itself, so
      // the role existing was never a precondition for restoring.
      const restorePath = account.role === 'student' ? identity.archivePath : null;

      const outcome = await tryProvision(
        db,
        { actorId, userId: account.id, pgRole, step: restorePath === null ? 'ensure' : 'restoreStudent' },
        async () => {
          if (restorePath !== null) {
            await prov.restoreStudent({ ...identity, canLogin: shouldLogin, archivePath: restorePath });
            return;
          }
          await (account.role === 'teacher'
            ? prov.ensureTeacher({ ...identity, canLogin: shouldLogin })
            : prov.ensureStudent({ ...identity, canLogin: shouldLogin }));
        },
      );

      if (!outcome.ok) {
        fail(pgRole, restorePath === null ? 'ensure' : 'restoreStudent', outcome.error ?? 'unknown');
        continue;
      }
      if (restorePath === null) {
        report.created.push(pgRole);
        continue;
      }

      // Same ordering argument as `applyStateToPostgres`: the bookkeeping goes
      // after the restore and outside `tryProvision`, so a meta hiccup cannot
      // report a restore that worked as one that did not. And the audit row is
      // written here too — the `reconciled` summary carries the role but not the
      // path, and "which dump did this account come back from" is exactly what
      // `user_restored` exists to answer, on the pass most likely to run it.
      report.restored.push(pgRole);
      await recordArchivePath(db, account.id, null);
      await audit(db, {
        actorId,
        action: 'user_restored',
        targetType: 'app_user',
        targetId: account.id,
        detail: { pgRole, archivePath: restorePath, via: 'reconcile' },
      });
      continue;
    } else if (account.role === 'student' && identity.archivePath !== null) {
      // A schema *and* a dump still named for it. Reachable when a restore
      // succeeded and only its bookkeeping failed. Not repaired from here: the
      // two ways to resolve it are clearing the column and dropping the schema,
      // and picking the wrong one destroys the account's work.
      anomaly(pgRole, 'has a schema and still names a dump — a restore whose record did not land');
    }

    // --- present: correct what disagrees ------------------------------------
    if (existing.canLogin !== shouldLogin) {
      const outcome = await tryProvision(
        db,
        { actorId, userId: account.id, pgRole, step: 'setLogin' },
        () => prov.setLogin(pgRole, shouldLogin),
      );
      if (outcome.ok) report.loginFixed.push(pgRole);
      else fail(pgRole, 'setLogin', outcome.error ?? 'unknown');
    }

    // The session rails, which a student can clear on their own role: all three
    // are USERSET, so `ALTER ROLE u_me RESET ALL` is permitted and used to be
    // permanent — `roleSettings` was only ever issued from `ensureRole`, which
    // this pass reaches only when the role or schema is missing. The impact is
    // bounded (the watchdog owns the wall clock, and `query.ts` always rolls
    // back) but a defence-in-depth layer that silently stops existing is worth
    // one statement to restore.
    if (!existing.hasSettings) {
      const outcome = await tryProvision(
        db,
        { actorId, userId: account.id, pgRole, step: 'applyRoleSettings' },
        () => prov.applyRoleSettings(pgRole),
      );
      if (outcome.ok) report.settingsFixed.push(pgRole);
      else fail(pgRole, 'applyRoleSettings', outcome.error ?? 'unknown');
    }

    // Checked for every state, not just active ones. An archived account is
    // NOLOGIN and still keeps CONNECT — `setLogin` is the boundary, and leaving
    // the grant off would mean restoring one to active silently failed to make
    // it usable again.
    if (!existing.canConnect) {
      const outcome = await tryProvision(
        db,
        { actorId, userId: account.id, pgRole, step: 'grantConnect' },
        () => prov.grantConnect(pgRole),
      );
      if (outcome.ok) report.connectFixed.push(pgRole);
      else fail(pgRole, 'grantConnect', outcome.error ?? 'unknown');
    }

    // Not for a cold account: there is no schema, so every `grantTeacher` would
    // fail with the same error on every pass and bury the report in noise about
    // a state that is correct. The grants come back with the schema, because
    // `restoreStudent` ends in `ensureStudent`.
    if (account.role === 'student' && account.state !== 'cold') {
      await reconcileGrants(db, prov, actorId, account, identity, inventory, report, fail);
    }
  }

  if (!reportIsClean(report)) {
    await audit(db, {
      actorId,
      action: 'reconciled',
      detail: {
        created: report.created,
        loginFixed: report.loginFixed,
        connectFixed: report.connectFixed,
        granted: report.granted,
        revoked: report.revoked,
        dropped: report.dropped,
        restored: report.restored,
        anomalies: report.anomalies,
        failed: report.failed,
      },
    });
  }

  return report;
}

/**
 * Bring the USAGE grants on one student's schema in line with their roster.
 *
 * Two kinds of difference get fixed here, and the second one is not merely
 * bookkeeping:
 *
 *   - **missing** — a teacher who should be able to read this schema and
 *     cannot. Usually a seam that failed after its transaction committed.
 *
 *   - **extra** — anyone holding USAGE who is not one of this student's
 *     teachers. That includes a teacher whose class was handed over while the
 *     revoke failed, and it also includes *another student*: a student owns
 *     their schema, and an owner may `GRANT USAGE ON SCHEMA u_me TO u_other`.
 *     Postgres has no way to forbid that, so architecture §8b's "strict
 *     isolation, always" is not preventable at the grant level — it is
 *     restored here instead. Periodically, therefore, not immediately: two
 *     students who agree to share can see each other's work until the next
 *     pass. They cannot reach anyone who did not agree, which is the property
 *     that actually matters.
 */
async function reconcileGrants(
  db: Db,
  prov: Provisioner,
  actorId: number | null,
  account: AccountRow,
  identity: PgIdentity,
  inventory: Awaited<ReturnType<Provisioner['inventory']>>,
  report: ReconcileReport,
  fail: (pgRole: string, step: string, error: string) => void,
): Promise<void> {
  const { pgRole } = account;
  const actual = inventory.usageGrants.get(pgRole) ?? new Set<string>();

  // Only teachers whose role actually exists — granting to a teacher who has
  // not been provisioned yet would fail, and they are earlier in this same
  // pass, so the next one picks it up.
  const desired = new Set(identity.teacherRoles.filter((t) => inventory.roles.has(t)));

  for (const teacher of desired) {
    if (actual.has(teacher)) continue;
    const outcome = await tryProvision(
      db,
      { actorId, userId: account.id, pgRole, step: 'grantTeacher' },
      () => prov.grantTeacher(pgRole, teacher),
    );
    if (outcome.ok) report.granted.push({ student: pgRole, teacher });
    else fail(pgRole, 'grantTeacher', outcome.error ?? 'unknown');
  }

  for (const grantee of actual) {
    // `dbk_app` is never granted USAGE here, but if a future migration does,
    // revoking it would lock provisioning out of the schema it has to manage.
    if (desired.has(grantee) || grantee === config.pg.user) continue;

    const reason = grantee.startsWith('t_')
      ? 'former_teacher'
      : grantee.startsWith('u_')
        ? 'peer_student'
        : grantee === PUBLIC_GRANTEE
          ? 'public'
          : 'unknown';

    // A grantee that is none of the four is left for a human instead of being
    // handed to `revokeTeacher`, which calls `assertRoleName` and would throw
    // on every pass forever — a permanent failure that repairs nothing and
    // buries the rest of the report under the same error each time. The
    // anomaly says what was seen; someone can then decide whether it is a
    // migration that granted deliberately or something that needs taking back.
    if (reason === 'unknown') {
      report.anomalies.push({
        pgRole,
        note: `USAGE on the schema is held by ${grantee}, which is neither a teacher, a student nor PUBLIC — left alone`,
      });
      continue;
    }

    const outcome = await tryProvision(
      db,
      { actorId, userId: account.id, pgRole, step: 'revokeTeacher' },
      () => prov.revokeTeacher(pgRole, grantee),
    );
    if (outcome.ok) report.revoked.push({ student: pgRole, grantee, reason });
    else fail(pgRole, 'revokeTeacher', outcome.error ?? 'unknown');
  }
}
