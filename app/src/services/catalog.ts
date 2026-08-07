/**
 * What the schema browser shows — phase 3.
 *
 * The same principle as the query runner: this reads the catalog over a
 * connection opened *as the student*, so the answer to "what may I see" comes
 * from Postgres rather than from a filter written here. That is why the
 * `has_schema_privilege` / `has_table_privilege` calls in `CATALOG_QUERY` are
 * load-bearing rather than decorative — `pg_class` and `pg_namespace` are
 * world-readable, so without them the browser would hand every student a list
 * of every other student's tables, which is a class roster.
 *
 * ## Why not just run the catalog query through /api/query
 *
 * The page could ask for this SQL the same way it asks for anything else, and
 * for a while that looked like the tidy answer — no new route, and provably the
 * student's own privileges. Two things killed it. `query_log` is the teacher's
 * live lesson view (phase 4), and a `pg_class` join arriving every time a
 * student expands a tree node is noise in it. And refreshing the tree while a
 * long query is running
 * would answer `429 too_many_queries` (the pool is 2 per student) — a browser
 * pane that stops working precisely when the Cancel button next to it becomes
 * interesting.
 */

import type pg from 'pg';
import type { Db } from '../db/query.js';
import { pgIdentity, ServiceError } from './users.js';

export interface CatalogColumn {
  name: string;
  type: string;
  notNull: boolean;
}

export interface CatalogTable {
  name: string;
  /** `table`, `view` or `matview` — the browser shows views differently. */
  kind: 'table' | 'view' | 'matview';
  columns: CatalogColumn[];
  /**
   * The planner's estimate, or null when Postgres has none.
   *
   * Not `count(*)`: that is one query per table on a connection the student
   * shares with the editor, and a freshly created table has never been
   * analysed, so the honest answer for the case that matters most — the table
   * they just made — is "I don't know yet" either way. The grid gives the real
   * number the moment they click the table.
   */
  estimatedRows: number | null;
}

export interface CatalogSchema {
  name: string;
  /** True for the caller's own schema, which the browser opens first. */
  own: boolean;
  tables: CatalogTable[];
}

export interface Catalog {
  /** The caller's Postgres role, which is also their schema name and username. */
  self: string;
  schemas: CatalogSchema[];
}

const KINDS: Record<string, CatalogTable['kind']> = {
  r: 'table',
  p: 'table', // a partitioned parent is a table as far as a lesson is concerned
  v: 'view',
  m: 'matview',
};

/**
 * One round trip for the whole tree.
 *
 * Driven from `pg_namespace` with the tables **left**-joined on, not from
 * `pg_class`. A schema the caller can read but which happens to hold nothing
 * would otherwise produce no rows and vanish from the tree entirely — and the
 * two people most likely to be in that position are the student who has just
 * pressed "reset my database" and the teacher looking at them. Absent and empty
 * would render identically, so "Lena has no tables yet" and "I have lost sight
 * of Lena" would be the same picture. They are not the same thing.
 *
 * Flat rows joined up in JS rather than a `json_agg` in the query: the shape is
 * assembled once here, where it is typed, instead of twice — once in SQL and
 * again in whatever reads it.
 */
const CATALOG_QUERY = `
  SELECT n.nspname                                   AS schema,
         c.relname                                   AS relation,
         c.relkind                                   AS kind,
         c.reltuples                                 AS reltuples,
         a.attname                                   AS column,
         format_type(a.atttypid, a.atttypmod)        AS type,
         a.attnotnull                                AS not_null
    FROM pg_catalog.pg_namespace n
    LEFT JOIN pg_catalog.pg_class c
           ON c.relnamespace = n.oid
          AND c.relkind = ANY ($1)
          -- On the JOIN rather than in WHERE: a schema whose tables are all
          -- unreadable must still appear, empty.
          AND has_table_privilege(c.oid, 'SELECT')
    LEFT JOIN pg_catalog.pg_attribute a
           ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname NOT LIKE 'pg\\_%'
     AND n.nspname <> 'information_schema'
     -- The isolation boundary, and the reason this runs as the student rather
     -- than from the admin pool: has_*_privilege answer for current_user, and
     -- pg_class is world-readable, so without them the tree would hand every
     -- student a list of every other student's tables.
     AND has_schema_privilege(n.oid, 'USAGE')
   ORDER BY n.nspname, c.relname, a.attnum`;

interface CatalogRow {
  schema: string;
  /** Null for a schema with nothing readable in it — the LEFT JOIN's empty side. */
  relation: string | null;
  kind: string | null;
  reltuples: number | null;
  column: string | null;
  type: string | null;
  not_null: boolean | null;
}

export interface CatalogReaderDeps {
  /** The meta database — identities in. */
  db: Db;
  /** The same per-student pool the query runner uses. Injected, not imported. */
  getPool: (pgRole: string, pgPassword: string) => pg.Pool;
}

export interface CatalogReader {
  read(userId: number): Promise<Catalog>;
}

export function makeCatalogReader(deps: CatalogReaderDeps): CatalogReader {
  const { db, getPool } = deps;

  return {
    async read(userId) {
      const identity = await pgIdentity(db, userId);
      if (!identity) {
        throw new ServiceError('not_provisioned', 'This account has no database of its own.');
      }
      if (identity.state !== 'active') {
        throw new ServiceError('user_not_active', 'This account is not active.');
      }

      const pool = getPool(identity.pgRole, identity.pgPassword);

      // Connect and query as two steps, the way the runner does, so that
      // "nothing came free" is attributed to the pool and a real database error
      // is allowed to be one. Wrapping both in a single catch would report a
      // broken catalog query as the student's own long-running SELECT.
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

      let result;
      try {
        result = await client.query<CatalogRow>(CATALOG_QUERY, [Object.keys(KINDS)]);
      } finally {
        client.release();
      }

      const schemas = new Map<string, CatalogSchema>();
      const tables = new Map<string, CatalogTable>();

      for (const row of result.rows) {
        let schema = schemas.get(row.schema);
        if (!schema) {
          schema = { name: row.schema, own: row.schema === identity.pgRole, tables: [] };
          schemas.set(row.schema, schema);
        }

        // The schema exists and is readable, but holds nothing this caller may
        // see. Registering it above and stopping here is the whole point of the
        // LEFT JOIN.
        if (row.relation === null) continue;

        const key = `${row.schema}.${row.relation}`;
        let table = tables.get(key);
        if (!table) {
          table = {
            name: row.relation,
            kind: (row.kind === null ? undefined : KINDS[row.kind]) ?? 'table',
            columns: [],
            // -1 is Postgres for "never analysed", which is not the same as
            // zero rows and must not be shown as one.
            estimatedRows:
              row.reltuples === null || row.reltuples < 0 ? null : Math.round(row.reltuples),
          };
          tables.set(key, table);
          schema.tables.push(table);
        }

        // A table with no columns at all (`CREATE TABLE t ()` is legal) comes
        // back as a single row from the LEFT JOIN with nothing on the right.
        if (row.column !== null) {
          table.columns.push({
            name: row.column,
            type: row.type ?? 'unknown',
            notNull: row.not_null ?? false,
          });
        }
      }

      return {
        self: identity.pgRole,
        // Own schema first, then everything else alphabetically. A student has
        // two entries and does not care; a teacher has one per student they
        // teach, and wants their own playground at the top.
        schemas: [...schemas.values()].sort((a, b) =>
          a.own === b.own ? a.name.localeCompare(b.name) : a.own ? -1 : 1,
        ),
      };
    },
  };
}
