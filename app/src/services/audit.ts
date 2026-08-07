/**
 * Append-only record of administrative and destructive actions.
 *
 * Distinct from `query_log`, which records what students *ran*. This records
 * what the app *did to accounts*: who created a teacher, who reset whose
 * password, who removed a student. When a class arrives on Monday and one
 * account is gone, this is the table that answers why.
 */

import type { Queryable } from '../db/query.js';

export type AuditAction =
  | 'bootstrap_admin_created'
  | 'teacher_created'
  | 'student_created'
  | 'user_state_changed'
  | 'user_renamed'
  | 'password_reset'
  | 'password_changed'
  | 'class_created'
  | 'class_updated'
  | 'class_archived'
  | 'class_member_added'
  | 'class_member_removed'
  // --- phase 2: the teaching database ---
  | 'schema_reset'
  | 'user_deprovisioned'
  | 'provision_failed'
  | 'reconciled'
  // --- phase 5b: the lifecycle (architecture §8b) ---
  //
  // `user_state_changed` fires for these transitions too, from inside the meta
  // transaction. These are the second half, written after the teaching database
  // has actually been touched, and they carry the one thing the first half
  // cannot: the path of the dump. A row saying cold with no `user_cold_stored`
  // beside it is an account whose schema is still sitting there.
  | 'user_cold_stored'
  | 'user_restored'
  /** One row per sweep that archived anybody — the list, not just the count. */
  | 'archive_swept'
  // --- phase 9: exercises ---
  //
  // `exercise_taken_back` is the destructive one and the reason this group
  // exists: it drops every student's tables in that class *and* their hand-ins,
  // so "the exercise vanished overnight" needs an answer, and the row carries
  // how many of each went with it.
  | 'exercise_created'
  | 'exercise_updated'
  | 'exercise_deleted'
  | 'exercise_distributed'
  | 'exercise_taken_back'
  | 'exercise_workspace_reset';

export async function audit(
  db: Queryable,
  entry: {
    actorId: number | null;
    action: AuditAction;
    targetType?: string;
    targetId?: string | number;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      entry.actorId,
      entry.action,
      entry.targetType ?? null,
      entry.targetId === undefined ? null : String(entry.targetId),
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}
