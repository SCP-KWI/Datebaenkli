/**
 * The disk quota — the keyword scan, the estimate, and the arithmetic.
 *
 * No database: `makeQuotaGuard` takes a `Queryable`, so a four-line stub that
 * answers with a byte count drives the real `check()` including the message it
 * throws. What needs a real server is whether `pg_total_relation_size` can be
 * read across roles at all — that is HANDOFF §4o's trap and it lives in
 * `import.live.test.mjs`.
 *
 * The claims worth pinning here are the ones where being wrong is quiet:
 * `mayGrow` must not match `created_at`, must match `SELECT … INTO`, and must
 * leave the student a way back under the limit.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;

process.env.DBK_ENCRYPTION_KEY ??= Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
// Not `'x'.repeat(48)`: `config.ts` now rejects a secret with fewer than 12
// distinct characters, because length alone let `'aaaa…'` through. A fixed
// literal keeps the tests deterministic while satisfying that.
process.env.DBK_SESSION_SECRET ??= 'test-session-secret-0123456789abcdefghijklmnop';
process.env.DBK_APP_DB_PASSWORD ??= 'test';

const { mayGrow, estimateImportBytes, makeQuotaGuard } = await import(dist('services/quota.js'));

// --- the keyword scan --------------------------------------------------------

test('a read-only lesson never asks the database anything', () => {
  for (const sql of [
    'SELECT * FROM kunden',
    'SELECT k.name, b.betrag FROM kunden k JOIN bestellungen b USING (kunden_nr)',
    'select count(*) from kunden group by ort having count(*) > 2;',
    'SHOW search_path;',
  ]) {
    assert.equal(mayGrow(sql), false, sql);
  }
});

test('the ordinary ways a student adds data are all caught', () => {
  for (const sql of [
    'INSERT INTO kunden VALUES (1)',
    'insert into kunden values (1)',
    'UPDATE kunden SET name = $$x$$',
    'CREATE TABLE t (a int)',
    'CREATE TABLE t AS SELECT * FROM generate_series(1, 1e9)',
    'ALTER TABLE kunden ADD COLUMN notiz text',
    'COPY kunden FROM STDIN',
    'REFRESH MATERIALIZED VIEW mv',
    'MERGE INTO ziel USING quelle ON true',
    'DO $$ BEGIN END $$',
    'CALL fuellen()',
  ]) {
    assert.equal(mayGrow(sql), true, sql);
  }
});

test('SELECT … INTO creates a table while starting with the safest keyword', () => {
  // The whole reason `into` is in the list. A leading-keyword classifier reads
  // this as a SELECT and waves it through.
  assert.equal(mayGrow('SELECT * INTO neue_kunden FROM kunden'), true);
});

test('EXPLAIN counts, because EXPLAIN ANALYZE actually runs the statement', () => {
  assert.equal(mayGrow('EXPLAIN ANALYZE INSERT INTO kunden VALUES (1)'), true);
  // And so does a plain EXPLAIN, which is the accepted over-refusal: telling
  // the two apart needs a parser, and the cost is that a student who is already
  // over quota cannot read a query plan until they have deleted something.
  assert.equal(mayGrow('EXPLAIN SELECT * FROM kunden'), true);
});

test('the way back under the limit is never refused', () => {
  // If any of these ever became "growing", a student over quota would have no
  // recovery except wiping their entire schema.
  for (const sql of [
    'DELETE FROM kunden WHERE jahr < 2020',
    'DROP TABLE grosse_tabelle',
    'TRUNCATE messwerte',
    'VACUUM FULL kunden',
  ]) {
    assert.equal(mayGrow(sql), false, sql);
  }
});

test('a keyword inside a longer identifier is not a keyword', () => {
  // `\b…\b` rather than a substring search. `created_at` is in half the demo
  // tables, and matching it would refuse every SELECT a student wrote.
  for (const sql of [
    'SELECT created_at FROM kunden',
    'SELECT * FROM updates',
    'SELECT intostadt FROM x',
    'SELECT * FROM insertions',
  ]) {
    assert.equal(mayGrow(sql), false, sql);
  }
});

test('comments are stripped before the scan', () => {
  // `-- create the table first` above a SELECT is an ordinary thing to have in
  // an editor, and refusing it would be baffling.
  assert.equal(mayGrow('-- create a table here later\nSELECT 1'), false);
  assert.equal(mayGrow('/* insert the rows tomorrow */ SELECT 1'), false);
  // But a comment cannot hide a real statement: the code after it is still scanned.
  assert.equal(mayGrow('-- harmless\nINSERT INTO t VALUES (1)'), true);
});

test('a string literal over-refuses, deliberately', () => {
  // Documented in services/quota.ts: stripping strings correctly means knowing
  // about dollar quoting and escape strings, and the cost of not doing it is
  // one confusing refusal for a student who is already over quota.
  assert.equal(mayGrow("SELECT * FROM kunden WHERE name = 'Insert'"), true);
});

// --- the estimate ------------------------------------------------------------

test('the import estimate counts values plus per-row overhead', () => {
  // 2 rows x 28 bytes of tuple header, plus 3 + 5 + 4 characters of value.
  assert.equal(estimateImportBytes([['abc', 'defgh'], ['ijkl', null]]), 56 + 12);
  assert.equal(estimateImportBytes([]), 0);
});

// --- the arithmetic ----------------------------------------------------------

/** A `Queryable` that answers every size question with one fixed number. */
const dbReporting = (bytes) => ({
  query: async () => ({ rows: [{ bytes: String(bytes) }], rowCount: 1 }),
});

test('under the limit is silent', async () => {
  const quota = makeQuotaGuard(dbReporting(10), 100);
  await quota.check('u_k3a_muster_lena');
  assert.deepEqual(await quota.usage('u_k3a_muster_lena'), {
    bytes: 10,
    quotaBytes: 100,
    overQuota: false,
  });
});

test('over the limit refuses, and the message names both numbers', async () => {
  const quota = makeQuotaGuard(dbReporting(60 * 1024 * 1024), 50 * 1024 * 1024);
  await assert.rejects(() => quota.check('u_k3a_muster_lena'), (err) => {
    assert.equal(err.code, 'quota_exceeded');
    assert.match(err.message, /60\.0 MB/);
    assert.match(err.message, /50\.0 MB/);
    // The student has to be told what still works, or the only recovery they
    // will find is the reset button — and it has to be the advice that
    // actually frees space. `DELETE` alone does not; see services/quota.ts.
    assert.match(err.message, /DROP TABLE or TRUNCATE/);
    assert.match(err.message, /DELETE on its own does not/);
    return true;
  });
});

test('an import that would cross the line is refused before it writes', async () => {
  // The case a post-hoc check cannot catch: 40 MB used, 20 MB incoming, and
  // nothing is over quota until it is 10 MB too late.
  const quota = makeQuotaGuard(dbReporting(40 * 1024 * 1024), 50 * 1024 * 1024);
  await quota.check('u_k3a_muster_lena', 5 * 1024 * 1024);
  await assert.rejects(
    () => quota.check('u_k3a_muster_lena', 20 * 1024 * 1024),
    (err) => err.code === 'quota_exceeded' && /would add about/.test(err.message),
  );
});

test('exactly at the limit is under it, not over', async () => {
  const quota = makeQuotaGuard(dbReporting(100), 100);
  await quota.check('u_k3a_muster_lena');
  assert.equal((await quota.usage('u_k3a_muster_lena')).overQuota, false);
});

test('a schema the catalog has no row for reads as empty, not as an error', async () => {
  // `LEFT JOIN` from `pg_namespace` still returns nothing when the *schema*
  // does not exist — an account mid-provisioning, or one the reconciler has
  // not repaired yet. Refusing their first CREATE TABLE for quota reasons
  // would be a confusing way to report "you have no schema".
  const quota = makeQuotaGuard({ query: async () => ({ rows: [], rowCount: 0 }) }, 100);
  assert.equal((await quota.usage('u_missing')).bytes, 0);
  await quota.check('u_missing');
});
