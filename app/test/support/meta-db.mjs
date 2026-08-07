/**
 * A migrated meta database in PGlite, shared by the test files that need one.
 *
 * Not a `*.test.mjs`, so `npm test`'s glob does not run it.
 *
 * PGlite runs the real migration, so the CHECK constraints, the partial unique
 * indexes and the enum types are all live — which is the point: most of the
 * rules these services rely on are enforced by the schema, and a mock would
 * simply agree with whatever the code does.
 *
 * KNOWN GAP: PGlite is single-user and cannot execute a single GRANT. Anything
 * involving roles or privileges belongs to provision.live.test.mjs, which needs
 * a real server.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = join(import.meta.dirname, '..', '..');

/** Import a compiled module out of dist/, the way the tests exercise real code. */
export const dist = (p) => pathToFileURL(join(root, 'dist', p)).href;

process.env.DBK_ENCRYPTION_KEY ??= Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
// Not `'x'.repeat(48)`: `config.ts` now rejects a secret with fewer than 12
// distinct characters, because length alone let `'aaaa…'` through. A fixed
// literal keeps the tests deterministic while satisfying that.
process.env.DBK_SESSION_SECRET ??= 'test-session-secret-0123456789abcdefghijklmnop';
process.env.DBK_APP_DB_PASSWORD ??= 'test';

/**
 * Every meta migration, in filename order — the same rule `db/migrate.ts`
 * applies, deliberately not a hardcoded list. It was a hardcoded `001_init.sql`
 * until phase 5b added a second file, at which point every service test failed
 * on a column that exists everywhere except here. A test harness that has to be
 * edited whenever a migration is added will be the last thing anyone edits.
 */
const META_DIR = join(root, 'src', 'db', 'sql', 'meta');
const META_SQL = readdirSync(META_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(META_DIR, f), 'utf8'))
  .join('\n');

/**
 * A `Db` (src/db/query.ts) backed by PGlite.
 *
 * PGlite is one connection, so BEGIN/COMMIT on it directly is a genuine
 * transaction — the reason `Db.tx` exists as an interface rather than being
 * hard-wired to pg.Pool.connect().
 */
export function pgliteDb(pglite) {
  const queryable = {
    async query(text, values) {
      const result = await pglite.query(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  return {
    ...queryable,
    async tx(fn) {
      await pglite.query('BEGIN');
      try {
        const out = await fn(queryable);
        await pglite.query('COMMIT');
        return out;
      } catch (err) {
        await pglite.query('ROLLBACK').catch(() => {});
        throw err;
      }
    },
  };
}

/** A migrated meta database with one admin (id returned) already in it. */
export async function freshMeta() {
  const pglite = new PGlite();
  await pglite.waitReady;
  // GRANT/REVOKE are stripped rather than the files being split: running the
  // same DDL the server will is the whole reason this uses PGlite at all.
  await pglite.exec(META_SQL.replace(/^GRANT .*?;$/gms, '').replace(/^REVOKE .*?;$/gms, ''));
  const db = pgliteDb(pglite);
  const { rows } = await db.query(
    `INSERT INTO app_user (username, display_name, role, password_hash)
     VALUES ('admin', 'Admin', 'admin', 'x') RETURNING id`,
  );
  return { db, adminId: rows[0].id };
}
