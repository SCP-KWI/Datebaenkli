/**
 * Splitting a pasted class list into first and last names.
 *
 * Its own module for one reason: it is the only part of the roster page that
 * can be wrong *silently*, and it is the part whose mistakes are permanent.
 * Identifiers are never re-issued (docs/HANDOFF.md §3), so a line parsed the
 * wrong way round is `u_k3a_lena_muster` for the life of the account — there is
 * no rename, only a second account with a `2` on the end. `roster.js` needs a
 * DOM and a session to import at all; this needs neither, so `names.test.mjs`
 * can pin the cases the way `csv.test.mjs` pins the Swiss date coercions, and
 * for the same reason: a wrong answer here is not an error, just a wrong answer.
 */

/**
 * One line → `{ firstName, lastName }`, or null for a blank line.
 *
 * `order` is the teacher's choice, because there is nothing to infer from:
 * "Muster Lena" and "Lena Muster" are both ordinary Swiss class lists. Two
 * separators override it, because they carry the order themselves — a comma is
 * universally "Nachname, Vorname", and a tab is two Excel columns in the order
 * the caller named.
 *
 * Everything else splits on spaces, and the multi-word remainder goes to the
 * *surname*: "Von Gunten Anna" is a name this school has, and "Von" is not a
 * first name. That heuristic is right more often than the alternative and wrong
 * sometimes either way, which is why the page previews the result rather than
 * trusting it.
 */
export function parseLine(line, order) {
  const text = String(line).trim().replace(/\s+/g, ' ');
  if (text === '') return null;

  // `>= 2`, not `=== 2`: a third field is a class or a mail address pasted from
  // a CSV opened as text, and dropping it is what the teacher wants. Requiring
  // exactly two sent "Muster, Lena, 3a" down the space-splitting path below with
  // the commas still in it, yielding the surname "Muster, Lena," — a separator
  // welded into a name that can never be changed.
  const comma = text.split(',');
  if (comma.length >= 2) {
    return { lastName: comma[0].trim(), firstName: comma[1].trim() };
  }

  // Split the *raw* line: `text` has already collapsed tabs into spaces.
  const columns = String(line).split('\t').map((part) => part.trim()).filter(Boolean);
  const parts = columns.length === 2 ? columns : text.split(' ');
  if (parts.length === 1) return { lastName: parts[0], firstName: '' };
  if (columns.length === 2) {
    return order === 'first-last'
      ? { firstName: parts[0], lastName: parts[1] }
      : { firstName: parts[1], lastName: parts[0] };
  }

  return order === 'first-last'
    ? { firstName: parts[0], lastName: parts.slice(1).join(' ') }
    : { firstName: parts[parts.length - 1], lastName: parts.slice(0, -1).join(' ') };
}

export function parseNames(text, order) {
  return String(text)
    .split('\n')
    .map((line) => parseLine(line, order))
    .filter(Boolean);
}
