/**
 * CSV upload — turning a parsed file into a table in the student's own schema.
 *
 * `services/csv.ts` decides what the file *says*; this file decides what
 * Postgres is *told*. It is the second file in the app that builds SQL by
 * string concatenation, and CLAUDE.md reserves that for `provision.ts`, so the
 * exception is stated here rather than discovered later:
 *
 * ## Why string-built DDL is a different hazard here
 *
 * The rule exists because a bad identifier reaching `provision.ts` becomes
 * arbitrary SQL executed as **`dbk_app`**, which can create roles and drop
 * schemas. This file's `CREATE TABLE` runs on a connection opened *as the
 * student* (db/pools.ts), so the worst a name that somehow escaped quoting
 * could do is exactly what that student can already do by typing it into the
 * editor two panes away. The isolation invariant is unchanged: Postgres is
 * still the thing enforcing it.
 *
 * That is an argument for the blast radius, not for being careless, so names
 * get the same two independent treatments `db/ident.ts` gives role names:
 * folded to `[a-z_][a-z0-9_]*` first (`foldRelationName`), then checked against
 * that pattern by `assertPlainIdent`, then quoted. Column *types* need neither,
 * because they never come from the request as text — the route resolves them
 * through the `COLUMN_TYPES` union first, so the only strings that reach the
 * DDL are the seven literals in that array.
 *
 * ## Why parameterised INSERT rather than COPY … FROM STDIN
 *
 * Architecture §4 specified `pg-copy-streams`. COPY's wire format is
 * hand-escaped text — tab, newline, backslash and `\N` all mean something —
 * which would make this file responsible for building *data* by concatenation
 * as well as SQL. Batched multi-row `INSERT` keeps every value in a `$n`
 * placeholder, which is the rule the rest of the codebase follows without
 * exception, and it costs throughput nobody can perceive at a 10 MB cap: the
 * whole import is one transaction of at most a few hundred round trips.
 *
 * ## Why the values are already text
 *
 * `coerce` has normalised every cell to a form Postgres has exactly one reading
 * of (`2025-04-03`, never `03.04.2025` — see csv.ts). They are sent as text
 * parameters and cast by the target column's type, so the database still has
 * the last word on what is valid; we have only removed the ambiguity it would
 * otherwise resolve wrongly and silently.
 */

import type pg from 'pg';
import { MAX_IDENTIFIER_BYTES, fold } from '../auth/identifiers.js';
import { assertOwnedSchema, assertPlainIdent, assertRoleName, quoteIdent } from '../db/ident.js';
import type { Db } from '../db/query.js';
import {
  type ColumnType,
  type ParsedCsv,
  coerce,
  inferColumns,
  parseCsv,
  usesDecimalComma,
} from './csv.js';
import { type QueryError, recordQuery, toQueryError } from './query.js';
import { estimateImportBytes, type QuotaGuard } from './quota.js';
import { pgIdentity, ServiceError } from './users.js';

/**
 * The upload cap. `server.ts` sets a 12 MB body limit to leave headroom for
 * JSON string escaping on top of this.
 */
export const MAX_CSV_LENGTH = 10 * 1024 * 1024;

/** Well past any lesson, and low enough that one import cannot fill a 50 MB quota alone. */
export const MAX_IMPORT_ROWS = 100_000;
export const MAX_IMPORT_COLUMNS = 100;

/** How much of the file the preview shows. Enough to see the shape, not to scroll. */
export const PREVIEW_ROWS = 20;

/**
 * Postgres's hard limit is 65535 bind parameters per statement; the row cap
 * keeps a wide table's batch from becoming a multi-megabyte statement anyway.
 */
const MAX_PARAMS_PER_STATEMENT = 60_000;
const MAX_ROWS_PER_STATEMENT = 1_000;

/** Enough bad cells to see the pattern; a report of 40 000 is not a report. */
const MAX_REPORTED_ERRORS = 20;

/** SQLSTATE 42P07 — relation already exists. */
const DUPLICATE_TABLE = '42P07';

export interface ImportColumn {
  name: string;
  type: ColumnType;
}

/** One cell the student's chosen type could not accept. */
export interface CellError {
  /** The line in their file, as their spreadsheet numbers it. */
  line: number;
  column: string;
  value: string;
  expected: ColumnType;
}

export interface ImportPreview {
  /** The proposed table name, already folded — this is what will be created. */
  table: string;
  delimiter: string;
  hasHeader: boolean;
  columns: {
    /** The header cell as written in the file, so the student recognises it. */
    sourceName: string;
    /** The folded, collision-free identifier it will become. */
    name: string;
    type: ColumnType;
  }[];
  rows: string[][];
  totalRows: number;
  /** True when the file holds more rows than `rows` shows. */
  truncated: boolean;
  /** True when the file holds more rows than an import would accept at all. */
  tooManyRows: boolean;
  /**
   * True when the file is wider than an import would accept at all. The grid
   * above it shows the first `MAX_IMPORT_COLUMNS` columns, so without this the
   * preview would look perfectly fine and the confirm would be refused.
   */
  tooManyColumns: boolean;
}

export interface ImportRequest {
  csv: string;
  table: string;
  columns: ImportColumn[];
  delimiter?: string | undefined;
  hasHeader?: boolean | undefined;
  /** Drop an existing table of the same name first. */
  replace: boolean;
}

export interface ImportOutcome {
  ok: boolean;
  /** `schema.table`, so the success message can hand back runnable SQL. */
  table?: string;
  rowCount?: number;
  /** Cells the chosen types rejected. Present only when `ok` is false. */
  errors?: CellError[];
  /** A Postgres error, when the failure came from the database rather than the data. */
  error?: QueryError;
}

export interface Importer {
  run(userId: number, request: ImportRequest): Promise<ImportOutcome>;
}

export interface ImporterDeps {
  /** The meta database — identities in, `query_log` out. */
  db: Db;
  /** The per-schema disk limit. This is the one request that can blow it in one go. */
  quota: QuotaGuard;
  /** The same per-student pool the runner and the catalog use. Injected, not imported. */
  getPool: (pgRole: string, pgPassword: string) => pg.Pool;
}

// --- names -------------------------------------------------------------------

/**
 * `Umsätze 2025.csv` → `umsaetze_2025`.
 *
 * Not `fold()` on its own: that strips every separator, so `umsaetze_2025`
 * would come back as `umsaetze2025` and `first name` as `firstname`. Folding
 * each run of letters and digits separately and rejoining with `_` keeps the
 * word boundaries a student put there — which matters, because this name is
 * something they will have to type in the editor afterwards.
 *
 * Returns `''` when nothing survives (a header written entirely in a
 * non-Latin script); callers decide what to do about it, because a column can
 * be given a positional fallback and a table name cannot.
 */
export function foldRelationName(input: string): string {
  const joined = input
    .split(/[^\p{L}\p{N}]+/u)
    .map(fold)
    .filter((part) => part !== '')
    .join('_');

  // A leading digit is legal in a *quoted* identifier, but `2025_umsaetze`
  // unquoted is a syntax error — and the student will be typing it unquoted.
  const safe = /^[0-9]/.test(joined) ? `_${joined}` : joined;
  return safe.slice(0, MAX_IDENTIFIER_BYTES);
}

/**
 * The default table name, from the uploaded file's name.
 *
 * The extension is stripped here rather than in `foldRelationName`, which is
 * also used for *column* names — where `preis.chf` is a header, not a file, and
 * must not lose its second half.
 */
function tableNameFromFilename(filename: string): string {
  return foldRelationName(filename.replace(/\.[a-z0-9]{1,8}$/i, ''));
}

/**
 * Fold every column name, then break ties.
 *
 * `Name` and `NAME` are two perfectly ordinary spreadsheet headers and one
 * Postgres identifier. Suffixing the later one is the only option that does not
 * lose a column: failing the import would strand a file the student cannot
 * edit, and folding both to `name` would make `CREATE TABLE` fail with a
 * duplicate-column error that says nothing about which two headers collided.
 */
function foldColumnNames(sourceNames: readonly string[]): string[] {
  const used = new Set<string>();
  return sourceNames.map((source, i) => {
    const base = foldRelationName(source) || `spalte${i + 1}`;
    let name = base;
    // The suffix has to fit *inside* 63 bytes, not be appended to them —
    // Postgres truncates silently, which would turn `…_10` and `…_11` back into
    // one name and fail the CREATE with a duplicate-column error instead.
    for (let n = 2; used.has(name); n++) {
      const suffix = `_${n}`;
      name = base.slice(0, MAX_IDENTIFIER_BYTES - suffix.length) + suffix;
    }
    used.add(name);
    return name;
  });
}

// --- preview -----------------------------------------------------------------

/**
 * Parse, infer, and describe — no database, no identity, no side effects.
 *
 * Pure on purpose. The confirm step re-parses the same bytes with the
 * `delimiter` and `hasHeader` this returned, so nothing has to be remembered
 * between the two requests; there is no server-side upload state to expire,
 * leak, or get confused about when a student has two tabs open.
 *
 * `overrides` is what makes the preview's checkboxes work. Ticking "the first
 * row holds column names" has to re-run *inference*, not just relabel the grid
 * — a column loses or gains a value, which can change its type and always
 * changes its name. Doing that arithmetic a second time in the browser is how
 * the two halves drift apart; asking again is one round trip.
 */
export function previewCsv(
  csv: string,
  filename = '',
  overrides: { delimiter?: string | undefined; hasHeader?: boolean | undefined } = {},
): ImportPreview {
  const parsed = parseCsv(csv, {
    ...(overrides.delimiter === undefined ? {} : { delimiter: overrides.delimiter }),
    ...(overrides.hasHeader === undefined ? {} : { hasHeader: overrides.hasHeader }),
    maxRows: MAX_IMPORT_ROWS,
    maxColumns: MAX_IMPORT_COLUMNS,
  });
  const inferred = inferColumns(parsed);
  const names = foldColumnNames(inferred.map((c) => c.sourceName));

  return {
    table: tableNameFromFilename(filename) || 'tabelle',
    delimiter: parsed.delimiter,
    hasHeader: parsed.hasHeader,
    columns: inferred.map((column, i) => ({
      sourceName: column.sourceName,
      name: names[i]!,
      type: column.type,
    })),
    rows: parsed.rows.slice(0, PREVIEW_ROWS),
    totalRows: parsed.totalRows,
    truncated: parsed.totalRows > Math.min(parsed.rows.length, PREVIEW_ROWS),
    tooManyRows: parsed.totalRows > MAX_IMPORT_ROWS,
    tooManyColumns: parsed.totalColumns > MAX_IMPORT_COLUMNS,
  };
}

// --- import ------------------------------------------------------------------

/**
 * Check every cell against the type the student chose, before opening a
 * connection.
 *
 * All of it, not the first failure: "row 41 is not a number" sends someone
 * hunting through 4000 rows one at a time, and the reason a student overrode
 * an inferred type is usually that they were right about most of the column.
 * Seeing the twenty exceptions together is what tells them whether to fix the
 * file or pick `text`.
 */
function coerceRows(
  parsed: ParsedCsv,
  columns: readonly ImportColumn[],
): { values: (string | null)[][]; errors: CellError[] } {
  const decimalComma = usesDecimalComma(parsed.delimiter);
  const values: (string | null)[][] = [];
  const errors: CellError[] = [];

  for (const [r, row] of parsed.rows.entries()) {
    const out: (string | null)[] = [];
    for (const [c, column] of columns.entries()) {
      const raw = row[c] ?? '';
      const value = coerce(raw, column.type, decimalComma);
      if (value === undefined) {
        if (errors.length < MAX_REPORTED_ERRORS) {
          errors.push({
            line: parsed.lines[r] ?? r + 1,
            column: column.name,
            value: raw.slice(0, 100),
            expected: column.type,
          });
        }
        out.push(null); // unused: a non-empty `errors` aborts before the INSERT
      } else {
        out.push(value);
      }
    }
    values.push(out);
  }

  return { values, errors };
}

/**
 * Create one table and fill it, on a connection the caller has already opened
 * **as the schema's owner**. Returns the DDL it ran, for `query_log`.
 *
 * Lifted out of `makeImporter` in phase 9 so that exercise materialisation
 * (`services/exercise.ts`) can put a teacher's CSV fixture into a student's
 * workspace schema without writing a second copy of this. That is the whole
 * reason it exists — CLAUDE.md allows exactly two files to build SQL by string,
 * and the way to keep it at two is for the third caller to call *this* rather
 * than to grow its own.
 *
 * Not transactional on its own: both callers wrap it, and the exercise path
 * wraps several calls in one transaction so that a fixture of four tables lands
 * whole or not at all.
 *
 * `schema` is checked here rather than trusted from the caller — that is the
 * "checked once, then used twice" rule the comment further down states, and the
 * cost is a regex.
 */
export async function createAndFill(
  client: pg.PoolClient,
  request: {
    schema: string;
    /** Already folded by `foldRelationName`; re-checked here before quoting. */
    table: string;
    columns: readonly ImportColumn[];
    values: readonly (string | null)[][];
    replace: boolean;
  },
): Promise<{ target: string; ddl: string }> {
  const schema = assertOwnedSchema(request.schema);
  const target = `${quoteIdent(schema)}.${quoteIdent(assertPlainIdent(request.table))}`;
  // Checked once, then used twice. The DDL line below used to call
  // `quoteIdent(c.name)` without the assert, and was safe *only* because
  // the `columnList` below happened to run first and throw for the same
  // names. Reorder those two statements, or build the DDL somewhere else,
  // and the second of the two checks this file's header promises ("folded
  // … then re-checked … then quoted") disappears with no visible change.
  const safe = request.columns.map((c) => ({ name: assertPlainIdent(c.name), type: c.type }));
  const columnList = safe.map((c) => quoteIdent(c.name)).join(', ');
  const ddl = `CREATE TABLE ${target} (\n  ${safe
    .map((c) => `${quoteIdent(c.name)} ${c.type}`)
    .join(',\n  ')}\n)`;

  if (request.replace) {
    // No CASCADE: a view built on the old table blocks the drop with
    // Postgres's own explanation, which is a better outcome than
    // silently taking the student's view with it.
    await client.query(`DROP TABLE IF EXISTS ${target}`);
  }
  await client.query(ddl);

  // Each batch is one statement, so `statement_timeout` applies per
  // batch rather than to the import as a whole — which is why a large
  // file does not need the watchdog the query runner uses.
  const perStatement = Math.max(
    1,
    Math.min(MAX_ROWS_PER_STATEMENT, Math.floor(MAX_PARAMS_PER_STATEMENT / safe.length)),
  );
  for (let start = 0; start < request.values.length; start += perStatement) {
    const batch = request.values.slice(start, start + perStatement);
    const tuples = batch
      .map((_, r) => `(${safe.map((_, c) => `$${r * safe.length + c + 1}`).join(', ')})`)
      .join(', ');
    await client.query(`INSERT INTO ${target} (${columnList}) VALUES ${tuples}`, batch.flat());
  }

  return { target, ddl };
}

export function makeImporter(deps: ImporterDeps): Importer {
  const { db, quota, getPool } = deps;

  return {
    async run(userId, request) {
      const identity = await pgIdentity(db, userId);
      if (!identity) {
        throw new ServiceError('not_provisioned', 'This account has no database of its own.');
      }
      if (identity.state !== 'active') {
        throw new ServiceError('user_not_active', 'This account is not active.');
      }

      const table = foldRelationName(request.table);
      if (table === '') {
        throw new ServiceError(
          'invalid_table_name',
          'The table name must contain at least one letter or digit.',
        );
      }

      const parsed = parseCsv(request.csv, {
        // Re-parsed with what the preview reported, so the student confirms the
        // grid they were shown rather than whatever a second round of sniffing
        // would decide about the same bytes.
        ...(request.delimiter === undefined ? {} : { delimiter: request.delimiter }),
        ...(request.hasHeader === undefined ? {} : { hasHeader: request.hasHeader }),
        maxRows: MAX_IMPORT_ROWS,
        maxColumns: MAX_IMPORT_COLUMNS,
      });

      if (parsed.header.length === 0) {
        throw new ServiceError('empty_csv', 'The file holds no rows.');
      }
      if (parsed.totalRows > MAX_IMPORT_ROWS) {
        throw new ServiceError(
          'csv_too_many_rows',
          `The file holds ${parsed.totalRows} rows; at most ${MAX_IMPORT_ROWS} can be imported.`,
        );
      }
      // Before the width comparison below, not after: `parseCsv` clamped the
      // header to MAX_IMPORT_COLUMNS, so a 5000-column file arrives here
      // looking exactly like a 100-column one and would import its first
      // hundred columns silently.
      if (parsed.totalColumns > MAX_IMPORT_COLUMNS) {
        throw new ServiceError(
          'csv_too_many_columns',
          `The file has ${parsed.totalColumns} columns; at most ${MAX_IMPORT_COLUMNS} can be imported.`,
        );
      }
      if (request.columns.length !== parsed.header.length) {
        // The file changed under the preview, or the client dropped a column.
        // Creating a table with the wrong width would put every value in the
        // wrong column, which is worse than refusing.
        throw new ServiceError(
          'column_count_mismatch',
          `The file has ${parsed.header.length} columns but ${request.columns.length} were described.`,
        );
      }

      const columns = request.columns.map((column, i) => ({
        name: foldRelationName(column.name) || `spalte${i + 1}`,
        type: column.type,
      }));
      if (new Set(columns.map((c) => c.name)).size !== columns.length) {
        throw new ServiceError('duplicate_column_name', 'Two columns fold to the same name.');
      }

      const { values, errors } = coerceRows(parsed, columns);
      if (errors.length > 0) {
        // Not a thrown ServiceError: this is the expected outcome of a student
        // insisting a column is a number, and the per-cell detail is the whole
        // lesson. Same shape and same reasoning as a failed /api/query — see
        // routes/query.ts.
        return { ok: false, errors };
      }

      // The quota, checked here and not at the route: this is the only request
      // in the app that can add tens of megabytes in one go, and it is the only
      // one that knows how much *before* it writes anything. Everything above
      // is pure CPU on bytes we already hold, so the refusal still costs one
      // catalog query and no connection.
      //
      // After the per-cell report, deliberately. A file whose types are wrong
      // is going to be re-uploaded smaller or not at all, and "row 41 is not a
      // number" is a more useful thing to be told than "you are out of space".
      const replacing = request.replace
        ? await quota.relationBytes(identity.pgRole, table)
        : 0;
      await quota.check(
        identity.pgRole,
        Math.max(0, estimateImportBytes(values) - replacing),
      );

      // Qualified with the caller's own schema rather than left to search_path.
      // `"$user", public` would resolve correctly today, but "the table went
      // somewhere else" is a silent failure and naming the schema costs one
      // string we already hold — allow-listed, because it is interpolated.
      const schema = assertRoleName(identity.pgRole);

      const pool = getPool(identity.pgRole, identity.pgPassword);
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch {
        // Hedged on purpose — `services/query.ts` has the argument, and §4dd is
        // the day the confident version cost.
        throw new ServiceError(
          'too_many_queries',
          'No database connection was free. Usually one of your own queries is still ' +
            'running; if not, the server is refusing connections.',
        );
      }

      const startedAt = Date.now();
      let committed = false;
      let outcome: ImportOutcome;
      // Only used by `recordQuery` below, which runs whether the import
      // succeeded or not — so it needs a value even on the path where
      // `createAndFill` threw before producing one.
      let ddl = '';

      try {
        // One transaction for the whole import, so a failure half way through
        // leaves no table at all rather than a table holding some of the rows —
        // the state in which a student would most plausibly assume it worked.
        await client.query('BEGIN');
        ({ ddl } = await createAndFill(client, {
          schema,
          table,
          columns,
          values,
          replace: request.replace,
        }));
        await client.query('COMMIT');
        committed = true;
        outcome = { ok: true, table: `${schema}.${table}`, rowCount: values.length };
      } catch (err) {
        const error = toQueryError(err);
        if (error.code === DUPLICATE_TABLE) {
          // A conflict with the request, not a lesson: the answer is to pick
          // another name or tick "replace", so it belongs in the 4xx path.
          throw new ServiceError(
            'table_exists',
            `A table called "${table}" already exists in your schema.`,
          );
        }
        outcome = { ok: false, error };
      } finally {
        if (!committed) await client.query('ROLLBACK').catch(() => {});
        client.release();
      }

      // The generated DDL, not the CSV: `query_log` is what phase 4's live
      // lesson view renders, and "Lena ran CREATE TABLE kunden" is the line a
      // teacher can read. The rows arrived by INSERT, so the count says so.
      await recordQuery(db, userId, ddl, {
        durationMs: Date.now() - startedAt,
        rowCount: outcome.ok ? (outcome.rowCount ?? 0) : 0,
        error: outcome.error,
      });

      return outcome;
    },
  };
}
