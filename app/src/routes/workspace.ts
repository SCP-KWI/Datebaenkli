/**
 * The caller's own database — what is in it, and wiping it.
 *
 * Same audience as routes/query.ts and for the same reason: a student, or a
 * teacher in their own playground schema. Admins are excluded because they have
 * no Postgres identity to describe or reset.
 *
 * Both routes act on `currentUser(req)` and take no id. That is the whole
 * authorisation story — there is no path through this file that names another
 * account, so there is nothing to check beyond "is there a session". The
 * staff-facing equivalents live in routes/students.ts, where the
 * teacher-owns-student rule is enforced properly.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/query.js';
import { currentUser, requireRole } from '../http/auth.js';
import { asObject, bool, list, oneOf, optionalStr, str } from '../http/validate.js';
import type { CatalogReader } from '../services/catalog.js';
import { COLUMN_TYPES, DELIMITERS } from '../services/csv.js';
import type { ExerciseService } from '../services/exercise.js';
import {
  MAX_CSV_LENGTH,
  MAX_IMPORT_COLUMNS,
  type Importer,
  previewCsv,
} from '../services/import.js';
import type { Provisioner } from '../services/provision.js';
import type { QuotaGuard } from '../services/quota.js';
import { resetStudentSchema } from '../services/users.js';

const ownDatabaseOnly = { preHandler: requireRole('student', 'teacher') };

/** The CSV arrives as a JSON string field — see the import routes for why. */
const csvBody = (body: Record<string, unknown>): string =>
  str(body, 'csv', { max: MAX_CSV_LENGTH });

/**
 * Not `optionalStr`: that trims, and a tab delimiter trims to nothing — the
 * round trip would silently fall back to re-sniffing for exactly the files
 * where sniffing is least reliable.
 */
const optionalDelimiter = (body: Record<string, unknown>): string | undefined =>
  body['delimiter'] === undefined || body['delimiter'] === null
    ? undefined
    : oneOf(body, 'delimiter', DELIMITERS);

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  db: Db,
  prov: Provisioner,
  catalog: CatalogReader,
  importer: Importer,
  quota: QuotaGuard,
  exerciseList: ExerciseService,
): void {
  /**
   * The schema browser's tree: every schema, table and column the caller can
   * read — plus what their own schema currently occupies.
   *
   * ## Why the quota is joined on here and not inside the catalog reader
   *
   * The two answers come from opposite ends of the connection story and each
   * service's header is an argument for its own end. `catalog.read` runs **as
   * the student**, because `has_*_privilege` answering for `current_user` is
   * the isolation boundary itself. `quota.usage` runs as **`dbk_app`** against
   * `pg_class`, because asking as the student would report every schema as zero
   * bytes (HANDOFF §4o, and §4q is the near miss). Folding one into the other
   * would put two contradictory-sounding rules in one function.
   *
   * The second reason is not stylistic: `routes/lesson.ts` calls the same
   * `catalog.read` for a teacher's drill-down, where the quota is already
   * rendered from `services/lesson.ts`. Putting it in the reader would measure
   * it twice per drill-down and give one screen two sources for one number.
   *
   * ## A failed measurement costs the number, not the tree
   *
   * `catalog.read` first and on its own: it is what the pane is *for*, and it
   * is the call that raises `not_provisioned` / `user_not_active` when those
   * are the truth. The quota is an extra, so an error measuring it answers
   * `quota: null` and lets the browser render without it — the same bargain
   * `mountVersion` and `hintFor` strike on the client. Logged at `warn`,
   * because a measurement that has started failing is a real thing to know and
   * a silent `null` would be the second way to learn it: from a student
   * suddenly refused a write with no warning line above the tree.
   */
  app.get('/api/workspace', ownDatabaseOnly, async (req) => {
    const user = currentUser(req);
    const workspace = await catalog.read(user.id);
    let usage = null;
    try {
      usage = await quota.usage(workspace.self);
    } catch (err) {
      req.log.warn({ err, schema: workspace.self }, 'quota measurement failed; serving the tree');
    }
    // Phase 9: the caller's exercise workspaces are schemas they own, so
    // `catalog.read` already lists them — under names like
    // `x7_u_k3a_muster_lena`, which is not a thing to show a fifteen-year-old.
    // The tree keeps the real name (it is what they have to type to qualify one)
    // and the browser puts the title beside it. On the same "an extra is not
    // worth the tree" bargain as the quota above, for the same reason.
    let exercises: { schema: string; title: string }[] = [];
    try {
      exercises = await exerciseList.workspacesFor(user.id);
    } catch (err) {
      req.log.warn({ err }, 'exercise labels failed; serving the tree unlabelled');
    }
    return { ...workspace, quota: usage, exercises };
  });

  /**
   * "Reset my database" — drop the schema and hand back an empty one, with the
   * teacher's grants put back (a reset destroys them; see HANDOFF §4b).
   *
   * Irreversible and takes no dump, exactly like the staff-facing route it
   * shares a service with. That is the point rather than an oversight: the
   * schema is a scratchpad, and being able to wreck it and start over without
   * asking anyone is what makes it safe to experiment in. The audit row is
   * written with the student as their own actor, so a reset in the log is
   * distinguishable from a teacher resetting them.
   */
  app.post('/api/workspace/reset', ownDatabaseOnly, async (req) => {
    const user = currentUser(req);
    return { ok: true, provisioning: await resetStudentSchema(db, prov, user.id, user.id) };
  });

  /**
   * Step one of a CSV upload: what does this file look like, and what types
   * would we guess?
   *
   * A POST that changes nothing, because the payload is up to 10 MB and a
   * query string is not that. It touches no database at all — `previewCsv` is
   * pure — but it is still behind the session gate, since answering it is CPU
   * the school is paying for.
   *
   * The CSV rides in a JSON string rather than as `multipart/form-data`, which
   * would be the obvious transport. It cannot be: `multipart` is one of the
   * three CORS-safelisted content types, and requiring `application/json` on
   * every state-changing call is this app's entire CSRF defence (server.ts).
   * Accepting multipart here would open the hole for the sake of one route.
   */
  app.post('/api/workspace/import/preview', ownDatabaseOnly, async (req) => {
    const body = asObject(req.body);
    return previewCsv(csvBody(body), optionalStr(body, 'filename', { max: 260 }) ?? '', {
      delimiter: optionalDelimiter(body),
      // Absent means "you decide"; present means the student has overruled the
      // guess, and `bool`'s fallback would quietly overrule them back.
      hasHeader: body['hasHeader'] === undefined ? undefined : bool(body, 'hasHeader', true),
    });
  });

  /**
   * Step two: create the table and fill it.
   *
   * The file is sent again rather than held server-side between the two calls.
   * That keeps the whole feature stateless — nothing to expire, nothing to leak
   * between two tabs, and no way for the confirm to act on bytes other than the
   * ones the preview described. `delimiter` and `hasHeader` come back with it
   * so the re-parse reproduces the grid the student actually looked at.
   *
   * Answers `200 { ok: false, errors }` when a chosen type rejects some cells.
   * That is the same call routes/query.ts makes and for the same reason: a
   * column that is not really a number is the expected outcome of learning
   * about data types, not an HTTP-level problem, and the per-cell detail is the
   * part worth reading.
   */
  app.post('/api/workspace/import', ownDatabaseOnly, async (req) => {
    const body = asObject(req.body);
    return importer.run(currentUser(req).id, {
      csv: csvBody(body),
      table: str(body, 'table', { max: 200 }),
      columns: list(
        body,
        'columns',
        (column) => ({
          name: str(column, 'name', { max: 200 }),
          type: oneOf(column, 'type', COLUMN_TYPES),
        }),
        MAX_IMPORT_COLUMNS,
      ),
      delimiter: optionalDelimiter(body),
      hasHeader: bool(body, 'hasHeader', true),
      replace: bool(body, 'replace', false),
    });
  });
}
