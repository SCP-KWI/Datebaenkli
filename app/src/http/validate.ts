/**
 * Request-body validation.
 *
 * Hand-rolled rather than zod/ajv-schema: the whole API is about twenty fields,
 * every one of them a string, an integer or a small list, and the failure
 * messages here are better than a JSON-pointer path. If the surface grows past
 * this, swap in a real schema library — but not before.
 */

import type { FastifyRequest } from 'fastify';
import { badRequest } from './errors.js';

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('invalid_body', 'Expected a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function str(
  body: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number } = {},
): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw badRequest('missing_field', `"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  const { min = 1, max = 200 } = opts;
  if (trimmed.length < min) {
    throw badRequest('field_too_short', `"${field}" must be at least ${min} characters.`);
  }
  if (trimmed.length > max) {
    throw badRequest('field_too_long', `"${field}" must be at most ${max} characters.`);
  }
  return trimmed;
}

/** Absent, null, or blank all read as "not given". Never throws for emptiness. */
export function optionalStr(
  body: Record<string, unknown>,
  field: string,
  opts: { max?: number } = {},
): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return str(body, field, { min: 0, ...opts }) || undefined;
}

/**
 * `{ field: value }`, or `{}` when the value is absent.
 *
 * Exists because `exactOptionalPropertyTypes` makes `{ x: undefined }` a
 * different thing from `{}`, and a service patch object must not carry a key it
 * was not asked to change. Spread it: `{ ...maybe('locale', locale) }`.
 */
export function maybe<K extends string, V>(
  field: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [field]: value } as Record<K, V>);
}

/** Passwords are not trimmed and not length-capped here — the service owns that rule. */
export function rawStr(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw badRequest('missing_field', `"${field}" is required.`);
  }
  if (value.length > 1024) {
    throw badRequest('field_too_long', `"${field}" is implausibly long.`);
  }
  return value;
}

export function bool(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw badRequest('invalid_field', `"${field}" must be a boolean.`);
  return value;
}

/**
 * A string restricted to a fixed set. Values that reach an enum-typed column
 * must be checked here, or an unknown value surfaces as a Postgres cast error
 * (a 500) instead of a 400.
 */
export function oneOf<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = body[field];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw badRequest('invalid_field', `"${field}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/** Path parameters arrive as strings; reject anything that is not a positive integer id. */
export function id(value: unknown, field = 'id'): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) {
    throw badRequest('invalid_id', `"${field}" must be a positive integer.`);
  }
  return n;
}

/**
 * A path parameter as an id. Wraps the `req.params` cast so it lives in one
 * place rather than at every route — the cast is unchecked, so a route
 * registered as `/:classId` while the handler reads `id` would otherwise fail
 * as a confusing 400 with nothing pointing at the mismatch.
 */
export function paramId(req: FastifyRequest, field = 'id'): number {
  return id((req.params as Record<string, string | undefined>)[field], field);
}

/**
 * Deduplicated, because callers compare the returned length against a row count
 * to detect unknown ids — and `WHERE id = ANY(...)` collapses duplicates, so a
 * double-clicked `[42, 42]` would otherwise report that student 42
 * does not exist.
 */
export function idList(body: Record<string, unknown>, field: string, max = 200): number[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('missing_field', `"${field}" must be a non-empty array.`);
  }
  if (value.length > max) {
    throw badRequest('list_too_long', `"${field}" may hold at most ${max} entries.`);
  }
  return [...new Set(value.map((v) => id(v, field)))];
}

export function list<T>(
  body: Record<string, unknown>,
  field: string,
  item: (entry: Record<string, unknown>, index: number) => T,
  max = 200,
): T[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('missing_field', `"${field}" must be a non-empty array.`);
  }
  if (value.length > max) {
    throw badRequest('list_too_long', `"${field}" may hold at most ${max} entries.`);
  }
  return value.map((entry, i) => item(asObject(entry), i));
}
