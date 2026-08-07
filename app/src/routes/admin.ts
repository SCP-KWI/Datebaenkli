/**
 * Instance-level operations on the teaching database — admin only.
 *
 * Teachers are deliberately excluded even from the read-only usage report: it
 * names every schema in the instance, which is a roster of every other
 * teacher's students.
 */

import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/query.js';
import { currentUser, requireRole } from '../http/auth.js';
import { sweepInactiveStudents, summariseSweep } from '../services/lifecycle.js';
import type { Provisioner } from '../services/provision.js';
import { reconcile, summarise } from '../services/reconcile.js';

const adminOnly = { preHandler: requireRole('admin') };

export function registerAdminRoutes(app: FastifyInstance, db: Db, prov: Provisioner): void {
  /**
   * Repair the teaching database against `app_user`.
   *
   * Also runs at startup (`DBK_RECONCILE_ON_BOOT`). Exposed here because the
   * usual reason to want it is that something outside the app was fixed — an
   * archive volume mounted, the database brought back up — and restarting to
   * act on that is a worse answer than pressing a button.
   *
   * Not `public`, obviously, but worth stating why it is admin rather than
   * staff: it can drop the schema of any account marked deleted.
   */
  app.post('/api/admin/reconcile', adminOnly, async (req) => {
    const user = currentUser(req);
    const report = await reconcile(db, prov, user.id);
    req.log.info(summarise(report));
    return { report };
  });

  /**
   * Run the nightly `active -> archived` sweep now.
   *
   * The same function the 03:40 timer calls, with an actor attached. Exposed
   * for the same reason `reconcile` is — waiting a day to find out what a
   * changed `DBK_ARCHIVE_AFTER_DAYS` will do is a bad way to learn it — and
   * admin rather than staff because it acts across every teacher's roster at
   * once, not just the caller's own students.
   *
   * Non-destructive: it takes logins away, which the roster puts back in one
   * click. There is deliberately no equivalent route for the destructive half
   * of the lifecycle; `cold` is one account at a time, through
   * `PATCH /api/students/:id/state`, and that is the whole of its scheduling.
   */
  app.post('/api/admin/archive-sweep', adminOnly, async (req) => {
    const user = currentUser(req);
    const report = await sweepInactiveStudents(db, prov, user.id);
    req.log.info(summariseSweep(report));
    return { report };
  });

  /**
   * Disk used per schema, against the per-student quota.
   *
   * The instance-wide view. Enforcement itself lives in `services/quota.ts`
   * and happens per request on the two write paths, which measure one schema
   * at a time; this is the same sum over all of them at once, and it is what
   * tells an admin whether the 50 MB default is anywhere near the truth.
   *
   * `overQuota` here therefore lists exactly the students who are currently
   * being refused — worth knowing when one of them says the editor is broken.
   */
  app.get('/api/admin/usage', adminOnly, async () => {
    const quotaBytes = config.limits.studentQuotaMb * 1024 * 1024;
    const schemas = await prov.schemaUsage();
    return {
      quotaBytes,
      totalBytes: schemas.reduce((sum, s) => sum + s.bytes, 0),
      overQuota: schemas.filter((s) => s.bytes > quotaBytes).map((s) => s.schema),
      schemas,
    };
  });
}
