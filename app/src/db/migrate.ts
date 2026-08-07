/**
 * Minimal SQL migration runner.
 *
 * Files in `src/db/sql/<target>/` are applied in filename order, each in its
 * own transaction, and recorded in `_migrations`. No dependency, no DSL — the
 * migrations are plain .sql so they can also be run by hand with psql when
 * debugging on the server.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/** Arbitrary but stable key, so two app instances can never migrate concurrently. */
const ADVISORY_LOCK_KEY = 8_147_236_501;

export interface MigrationResult {
  applied: string[];
  skipped: number;
}

export async function migrate(
  pool: pg.Pool,
  dir: string,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    log.warn(`no migrations found in ${dir}`);
    return { applied: [], skipped: 0 };
  }

  const client = await pool.connect();
  const applied: string[] = [];
  let skipped = 0;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM _migrations',
    );
    const seen = new Map(rows.map((r) => [r.filename, r.checksum]));

    for (const filename of files) {
      const sql = await readFile(join(dir, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = seen.get(filename);

      if (previous !== undefined) {
        if (previous !== checksum) {
          // Editing an applied migration means the database and the repo have
          // silently diverged. Refuse to start rather than guess.
          throw new Error(
            `Migration ${filename} has changed since it was applied. ` +
              `Never edit an applied migration — add a new one instead. ` +
              `(If this is a dev database, drop it and start over.)`,
          );
        }
        skipped++;
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          checksum,
        ]);
        await client.query('COMMIT');
        applied.push(filename);
        log.info(`applied migration ${filename}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(
          `Migration ${filename} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }

  return { applied, skipped };
}

/** Resolve a migration directory relative to the compiled output (dist/db/sql/...). */
export function sqlDir(target: 'meta' | 'teach'): string {
  return join(import.meta.dirname, 'sql', target);
}
