/**
 * Deriving Postgres identifiers from human names — architecture §2.
 *
 * A student's Postgres role name, their schema name and their app login are all
 * the same string. That is deliberate:
 *
 *   - role == schema makes Postgres's default search_path ("$user", public)
 *     resolve to the student's own schema with zero per-session setup;
 *   - login == role means the name a student types to log in is the same name
 *     they will type in `SELECT * FROM u_k3a_muster_lena.kunden`, which is the
 *     whole point of making these readable rather than opaque ids.
 *
 * Everything here is pure. The database only enters when resolving collisions
 * (`allocateIdentifier`), and even that is a single lookup.
 */

/** Postgres truncates identifiers at NAMEDATALEN-1 = 63 bytes. */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * Characters whose German/Swiss transliteration is more than accent removal.
 * Applied before NFD stripping, which would otherwise turn "ü" into "u".
 */
const TRANSLITERATE: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  å: 'aa',
  æ: 'ae',
  ø: 'oe',
  œ: 'oe',
  þ: 'th',
  ð: 'd',
  đ: 'd',
  ł: 'l',
};

/**
 * Fold an arbitrary human string down to `[a-z0-9]*`.
 *
 * NFC first, so a decomposed "u + combining diaeresis" (what iPadOS often
 * produces) still hits the transliteration table and becomes "ue" rather than
 * a bare "u".
 */
const COMBINING_MARKS = /[̀-ͯ]/g;

export function fold(input: string): string {
  let out = '';
  for (const ch of input.normalize('NFC').toLowerCase()) {
    out += TRANSLITERATE[ch] ?? ch;
  }
  return out
    .normalize('NFD')
    .replace(COMBINING_MARKS, '') // remaining accents: é -> e
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Fold, and fall back to a placeholder if nothing survives.
 *
 * A name written entirely in a non-Latin script folds to the empty string. We
 * still owe that student an account, so emit `x` and let the collision suffix
 * make it unique. Not elegant; the alternative is refusing to enrol them.
 */
function part(input: string): string {
  return fold(input) || 'x';
}

/** Truncate to 63 bytes, leaving `reserve` characters free for a suffix. */
function clamp(base: string, reserve = 0): string {
  // `base` is ASCII by construction, so one character is one byte.
  return base.slice(0, MAX_IDENTIFIER_BYTES - reserve);
}

/**
 * `u_<class>_<surname>_<firstname>` — e.g. `u_k3a_muster_lena`.
 *
 * The class code is included so that the same person in two different classes
 * is unambiguous on sight, and so a whole class sorts together in `\dn`.
 */
export function studentIdentifier(classCode: string, lastName: string, firstName: string): string {
  return clamp(`u_${part(classCode)}_${part(lastName)}_${part(firstName)}`);
}

/**
 * `t_<surname>` — e.g. `t_schaffner`. Teachers are few; the surname is enough.
 *
 * Falls back to the first name when the surname folds away entirely (a name
 * written in a non-Latin script), because `t_wei` is still a name someone can
 * recognise and `t_x` is not. Only when both vanish does the placeholder win.
 */
export function teacherIdentifier(lastName: string, firstName = ''): string {
  const last = fold(lastName);
  const first = fold(firstName);
  return clamp(`t_${last || first || 'x'}`);
}

/**
 * An exercise workspace schema — `x<exerciseId>_<pgRole>`, e.g.
 * `x7_u_k3a_muster_lena`. Phase 9.
 *
 * Not a role name, and the leading `x` is deliberate rather than decorative:
 * `db/ident.ts` keeps two disjoint allow-lists, and a name that cannot begin
 * `u_` or `t_` cannot be mistaken for something to `SET ROLE` to.
 *
 * The role part is clamped twice over — once against `MAX_IDENTIFIER_BYTES` and
 * once against the 58 the schema pattern allows — so a very long student name
 * comes back short rather than as a string that fails validation later. **A
 * clamp can therefore collide**, which is why the result is allocated through
 * `allocateIdentifier` against the names already handed out and then stored;
 * two students sharing one workspace schema would be an isolation break, not a
 * cosmetic one. See `meta/003_exercises.sql`.
 */
export function workspaceSchemaBase(exerciseId: number, pgRole: string): string {
  const prefix = `x${exerciseId}_`;
  // Three characters held back for `withSuffix`, which `candidates` bounds at
  // 500 and therefore at three digits. Without the reserve, `withSuffix` would
  // clamp against `MAX_IDENTIFIER_BYTES` alone and could hand back a 62-byte
  // name whose *tail* is 59 — legal as a Postgres identifier, rejected by
  // `db/ident.ts`'s 58, and the failure would surface only for the students with
  // the longest names and only on a collision. Twice hidden is once too many.
  const room = Math.min(55, MAX_IDENTIFIER_BYTES - prefix.length - 3);
  return prefix + pgRole.slice(0, room);
}

/** `base`, `base2`, `base3`, … re-clamped so the suffix never pushes past 63 bytes. */
export function withSuffix(base: string, n: number): string {
  if (n <= 1) return clamp(base);
  const suffix = String(n);
  return clamp(base, suffix.length) + suffix;
}

/**
 * Candidate names for `base`, in preference order. Capped rather than infinite
 * so a bug upstream surfaces as an error instead of a hang.
 */
export function* candidates(base: string, limit = 500): Generator<string> {
  for (let n = 1; n <= limit; n++) yield withSuffix(base, n);
}

/**
 * Pick the first candidate that is not already taken.
 *
 * `taken` should hold every live username *and* pg_role, since one string has
 * to be free as both. Callers run this inside the same transaction as the
 * INSERT; the partial unique indexes on `app_user` are the real guarantee if
 * two teachers enrol the same name at the same instant.
 */
export function allocateIdentifier(base: string, taken: ReadonlySet<string>): string {
  for (const candidate of candidates(base)) {
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not find a free identifier for "${base}" after 500 attempts.`);
}
