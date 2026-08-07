/**
 * Quoting for the one place in this app that cannot use bind parameters.
 *
 * Provisioning is DDL — `CREATE ROLE`, `CREATE SCHEMA`, `GRANT`, `SET ROLE`.
 * Postgres does not accept `$1` for an identifier in any of them, so the role
 * name has to be interpolated into the statement text. That makes this file the
 * single spot where a bad string becomes arbitrary SQL, which is why it does
 * two independent things rather than one:
 *
 *   1. `assertRoleName` rejects anything that is not a name we generate. It is
 *      an allow-list, not an escape: the only strings that get past it are the
 *      ones `auth/identifiers.ts` can produce.
 *   2. `quoteIdent` / `quoteLiteral` then quote correctly anyway.
 *
 * Either alone would do. Both, because the cost is a regex and the failure mode
 * is a student-supplied name reaching `DROP SCHEMA`.
 */

/**
 * Exactly what `studentIdentifier` / `teacherIdentifier` emit: `u_` or `t_`,
 * then folded ASCII, at most 63 bytes (Postgres's NAMEDATALEN - 1).
 *
 * The prefix is part of the pattern rather than a stylistic detail. Without it
 * the shape `[a-z][a-z0-9_]*` also matches `pg_catalog`, `postgres` and
 * `dbk_app` — all real, all things provisioning must never be pointed at, and
 * none of them distinguishable from a student by any general rule about
 * identifier syntax. Requiring the prefix makes the allow-list say what it
 * actually means: a role this application created.
 *
 * No dollar sign, which is legal in a Postgres identifier but never produced
 * by our folding.
 */
const ROLE_NAME = /^[ut]_[a-z0-9_]{1,61}$/;

/**
 * An exercise workspace schema — phase 9. `x<exerciseId>_<pgRole>`, clamped.
 *
 * A schema, never a role, and the leading `x` is what says so. It cannot match
 * `ROLE_NAME` above, which requires `u_` or `t_`, so the two allow-lists are
 * disjoint by construction: a workspace name can never be accepted by
 * `assertRoleName` and so can never reach `CREATE ROLE`, `DROP ROLE` or
 * `SET ROLE`, and a role name can never be accepted where a workspace is meant.
 * That is the same argument the `u_`/`t_` prefix makes one paragraph up, pointed
 * the other way.
 *
 * 58 rather than 61 because the prefix is longer; the real bound is
 * `MAX_IDENTIFIER_BYTES` and `workspaceSchemaName` is what enforces it.
 */
const WORKSPACE_SCHEMA = /^x[0-9]+_[a-z0-9_]{1,58}$/;

/** Names that come from configuration, not from a person: `dbk_app`, database names. */
const PLAIN_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function isRoleName(name: string): boolean {
  return ROLE_NAME.test(name);
}

export function isWorkspaceSchema(name: string): boolean {
  return WORKSPACE_SCHEMA.test(name);
}

/**
 * Check a name that an operator set rather than the app derived.
 *
 * `DBK_APP_DB_USER` and `DBK_TEACH_DB` are interpolated into `GRANT CONNECT ON
 * DATABASE ...` and `GRANT ... TO ...`, so they get the same treatment even
 * though whoever can edit the environment can already do worse. It costs a
 * regex and it turns a typo into a boot failure instead of a syntax error
 * mid-provisioning.
 */
export function assertPlainIdent(name: string): string {
  if (!PLAIN_IDENT.test(name)) {
    throw new Error(`Refusing to build SQL with the identifier ${JSON.stringify(name)}.`);
  }
  return name;
}

/**
 * Throw unless `name` is a Postgres role/schema name this app generated.
 *
 * Deliberately not a `ServiceError`: a name failing here is not a caller
 * mistake to be rendered as a 4xx, it is a bug or an attack, and it should
 * reach the 500 handler with a stack.
 */
export function assertRoleName(name: string): string {
  if (!isRoleName(name)) {
    throw new Error(`Refusing to build SQL with the identifier ${JSON.stringify(name)}.`);
  }
  return name;
}

/**
 * Throw unless `name` is an exercise workspace schema this app allocated.
 *
 * Same not-a-`ServiceError` reasoning as `assertRoleName`: a name failing here
 * did not come from `workspaceSchemaName`, and the only routes to that are a bug
 * or a hand-edited `exercise_workspace` row. Both want a stack.
 */
export function assertWorkspaceSchema(name: string): string {
  if (!isWorkspaceSchema(name)) {
    throw new Error(`Refusing to build SQL with the schema name ${JSON.stringify(name)}.`);
  }
  return name;
}

/**
 * Either allow-list — a schema some student or teacher owns, playground or
 * exercise workspace.
 *
 * The union rather than a looser pattern, deliberately. `services/import.ts`'s
 * `createAndFill` is the only caller: it puts a table into a schema chosen by
 * whichever of the two callers it has, and the thing it must never accept is a
 * schema name that is neither — `public`, `demo`, `pg_catalog`, or another
 * student's. Widening this to `PLAIN_IDENT` would accept all four.
 */
export function assertOwnedSchema(name: string): string {
  if (!isRoleName(name) && !isWorkspaceSchema(name)) {
    throw new Error(`Refusing to build SQL with the schema name ${JSON.stringify(name)}.`);
  }
  return name;
}

/** `foo` -> `"foo"`. Doubles embedded quotes, as Postgres requires. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `it's` -> `'it''s'`.
 *
 * Used for role passwords and for interval strings in `ALTER ROLE ... SET`.
 * A NUL byte cannot be represented in a Postgres string at all, so it is
 * rejected rather than silently mangled.
 */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('Refusing to build SQL with a NUL byte in a literal.');
  return `'${value.replace(/'/g, "''")}'`;
}
