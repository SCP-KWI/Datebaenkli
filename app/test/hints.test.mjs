/**
 * The SQLSTATE hint layer (phase 6a's analysis, phase 6b's two locales).
 *
 * Pure logic, no database and no DOM — the `names.test.mjs` precedent, and for
 * the same reason: this is the part of the SQL page a test can reach, and its
 * mistakes are silent. A hint that names the wrong table still renders.
 *
 * **Every `message` and `detail` string below was copied off a real PostgreSQL
 * server**, not composed to fit the regexes. That distinction is the whole
 * value of the file. Four of the shapes are not what they look like:
 * `demoo.kantone` reports 42P01 with the schema *inside* the quotes, 42703 has
 * three different phrasings and only one of them names its table, and 42P01
 * also covers `missing FROM-clause entry`, which is a different mistake
 * entirely. Getting a fresh one: run it in `psql` inside a
 * `GET STACKED DIAGNOSTICS` loop and paste what comes back.
 *
 * **6b split the analysis from the phrasing, and the assertions follow.** A
 * handler now returns a key and its substitutions, so the German assertions
 * below are a test of `i18n-de.js` *and* of the branch that chose the key. Each
 * case is rendered through both catalogues: the German assertions are the
 * detailed ones, carried over from 6a unchanged, and every case additionally
 * asserts that the English renders as English. That second half is what would
 * otherwise rot — nobody reads the English page daily, and a key that silently
 * falls back to German would look fine in a screenshot.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;

const { hintFor, renderHint, suggest, EXPLAINED } = await import(dist('web/assets/hints.js'));
const { translator } = await import(dist('web/assets/i18n.js'));
const { default: de } = await import(dist('web/assets/i18n-de.js'));
const { default: en } = await import(dist('web/assets/i18n-en.js'));

/** English falls back to German exactly as `i18n.js` wires it in the browser. */
const german = translator(de);
const english = translator(en, de);

/** The shape `/api/workspace` returns, trimmed to what a hint reads. */
const CATALOG = {
  self: 'u_k3a_muster_lena',
  schemas: [
    {
      name: 'u_k3a_muster_lena',
      own: true,
      tables: [
        {
          name: 'kunden',
          kind: 'table',
          columns: [{ name: 'id' }, { name: 'nachname' }, { name: 'alter' }],
        },
        { name: 'bestellungen', kind: 'table', columns: [{ name: 'id' }, { name: 'kunde_id' }] },
      ],
    },
    {
      name: 'demo',
      own: false,
      tables: [{ name: 'kantone', kind: 'view', columns: [{ name: 'kuerzel' }] }],
    },
  ],
};

const found = (code, message, extra = {}) => hintFor({ code, message, ...extra }, CATALOG);

/**
 * Render in German, and assert in passing that the same hint renders in English
 * without falling back.
 *
 * Folding the English check into the German helper is what keeps it honest:
 * every case below gets it for free, so adding a code with no English string is
 * a failing test rather than a thing to remember. `sameAsGerman` is the escape
 * hatch for the handful of strings that are genuinely identical in both.
 */
const hint = (code, message, extra = {}) => {
  const structured = found(code, message, extra);
  if (structured === null) return null;
  assertTranslated(structured);
  return renderHint(structured, german);
};

/** Every key a hint uses must be in `i18n-en.js` itself, not reached by fallback. */
function assertTranslated(structured) {
  const keys = [structured.key];
  if (structured.suggestion) keys.push(`hint.suggest.${structured.suggestion.kind}`);
  if (structured.suggestion) keys.push('hint.suggest.or');
  for (const key of keys) {
    assert.ok(
      Object.hasOwn(en, key),
      `${key} is missing from i18n-en.js — it would silently render in German`,
    );
  }
}

const inEnglish = (code, message, extra = {}) => renderHint(found(code, message, extra), english);

// --- the did-you-mean, on its own --------------------------------------------

test('a near miss is named; a different word is not', () => {
  assert.deepEqual(suggest('kunde', ['kunden', 'bestellungen']), {
    kind: 'near',
    names: ['kunden'],
  });
  // Two edits on a five-letter name is still inside tolerance; five is not.
  assert.equal(suggest('artikel', ['kunden', 'bestellungen']), null);
});

test('tolerance scales with length, because one letter means less in a long name', () => {
  // `id` vs `is` — one edit on a two-letter name is allowed …
  assert.deepEqual(suggest('is', ['id']), { kind: 'near', names: ['id'] });
  // … but one edit is *all* that is allowed there.
  assert.equal(suggest('xy', ['id']), null);
  // Three edits on a long name still resolves.
  assert.deepEqual(suggest('bestellungxx', ['bestellungen']), {
    kind: 'near',
    names: ['bestellungen'],
  });
});

test('a capitalisation-only difference is a diagnosis, not a guess', () => {
  // The student wrote "Kunden" *in quotes*. This is not a near miss — it is
  // certainly the cause, and the hint says something different because of it.
  assert.deepEqual(suggest('Kunden', ['kunden', 'kunde']), { kind: 'case', names: ['kunden'] });
});

test('ties are kept rather than broken at random', () => {
  const hit = suggest('kunde', ['kunden', 'kunder', 'bestellungen']);
  assert.equal(hit.kind, 'near');
  assert.deepEqual(hit.names.sort(), ['kunden', 'kunder']);
});

test('suggest survives the inputs a caller can actually hand it', () => {
  assert.equal(suggest('', ['kunden']), null);
  assert.equal(suggest('kunden', []), null);
  assert.equal(suggest('kunden', null), null);
  // An exact match is not a suggestion — it would read as nonsense.
  assert.equal(suggest('kunden', ['kunden']), null);
});

// --- 42P01, in its four disguises --------------------------------------------

test('a misspelled table names the one they meant', () => {
  const out = hint('42P01', 'relation "kunde" does not exist');
  assert.match(out, /Die Tabelle `kunde` gibt es nicht\./);
  assert.match(out, /Meintest du `kunden`\?/);

  assert.match(inEnglish('42P01', 'relation "kunde" does not exist'), /Did you mean `kunden`\?/);
});

test('a quoted name that differs only in case gets the lower-casing rule', () => {
  const out = hint('42P01', 'relation "Kunden" does not exist');
  assert.match(out, /`kunden`/);
  assert.match(out, /klein/, 'the explanation is the folding rule, not a guess');
  assert.doesNotMatch(out, /Meintest du/);

  // The same distinction has to survive translation: a capitalisation
  // difference is a diagnosis and must not read as a guess in English either.
  const translated = inEnglish('42P01', 'relation "Kunden" does not exist');
  assert.match(translated, /capitalisation/);
  assert.doesNotMatch(translated, /Did you mean/);
});

test('a qualified name keeps the schema inside the quotes, where Postgres puts it', () => {
  // The real message for `SELECT * FROM demo.kantonen`. Naively reading the
  // quoted text as a table name would look for a table called "demo.kantonen".
  const out = hint('42P01', 'relation "demo.kantonen" does not exist');
  assert.match(out, /In `demo` gibt es keine Tabelle `kantonen`\./);
  assert.match(out, /Meintest du `kantone`\?/);
});

test('an unknown schema is reported as a schema, and matched against real ones', () => {
  const out = hint('42P01', 'relation "demoo.kantone" does not exist');
  assert.match(out, /Das Schema `demoo` gibt es nicht/);
  assert.match(out, /Meintest du `demo`\?/);
});

test('a dot the catalog cannot vouch for is part of the name, not a schema', () => {
  // `CREATE TABLE "kunden.2025"` is legal SQL, and its 42P01 is indistinguishable
  // from a schema-qualified one — the schema is inside the quotes either way. So
  // the schema reading is only taken when a real schema backs it up. Found by
  // pasting an HTML-injection attempt in a browser: it escaped correctly, and
  // then announced that the schema `<img src=x onerror='document.title=String`
  // did not exist.
  const out = hint('42P01', 'relation "kunden.2025" does not exist');
  assert.doesNotMatch(out, /Schema/, `claimed a schema: ${out}`);
  assert.match(out, /Die Tabelle `kunden\.2025` gibt es nicht\./);

  const nasty = hint('42P01', `relation "<img src=x onerror='a.b.c'>" does not exist`);
  assert.doesNotMatch(nasty, /Schema/);

  // And in English, where `hint.table.unknown_alone` says "schema" nowhere but
  // `hint.schema.unknown` would.
  assert.doesNotMatch(inEnglish('42P01', 'relation "kunden.2025" does not exist'), /schema/);
});

test('a table that exists in another schema is named with its schema', () => {
  // `kantone` is real, but not in the student's own schema, so the fix is not a
  // spelling correction — it is the missing qualification.
  const out = hint('42P01', 'relation "kantone" does not exist');
  assert.match(out, /`demo\.kantone`/);
  assert.match(out, /Schema-Namen davor/);

  assert.match(inEnglish('42P01', 'relation "kantone" does not exist'), /`demo\.kantone`/);
});

test('missing FROM-clause entry is a different mistake and says so', () => {
  const out = hint('42P01', 'missing FROM-clause entry for table "kunde"');
  assert.match(out, /steht nicht im FROM/);
  assert.match(out, /Alias/, 'the alias case is the one a beginner hits');

  assert.match(inEnglish('42P01', 'missing FROM-clause entry for table "kunde"'), /alias/);
});

test('with nothing to suggest, the sentence still stands on its own', () => {
  const out = hint('42P01', 'relation "voellig_anderes" does not exist');
  assert.match(out, /Die Tabelle `voellig_anderes` gibt es nicht\./);
  assert.match(out, /Tabellenliste/);
  assert.doesNotMatch(out, /Meintest du/);
});

// --- 42703, in its three shapes ----------------------------------------------

test('a column error that names its table matches only that table', () => {
  const out = hint('42703', 'column "nachnahme" of relation "kunden" does not exist');
  assert.match(out, /Die Tabelle `kunden` hat keine Spalte `nachnahme`\./);
  assert.match(out, /Meintest du `nachname`\?/);
});

test('a bare column error matches across the tables the student can read', () => {
  const out = hint('42703', 'column "nachnahme" does not exist');
  assert.match(out, /Die Spalte `nachnahme` gibt es nicht\./);
  assert.match(out, /Meintest du `nachname`\?/);
});

test('an alias-qualified column arrives unquoted, and is still parsed', () => {
  // `SELECT k.nachnahme FROM kunden k` — note: no quotation marks at all.
  const out = hint('42703', 'column k.nachnahme does not exist');
  assert.match(out, /Die Spalte `nachnahme` gibt es in `k` nicht\./);
});

// --- the rest of the catalogue -----------------------------------------------

test('a syntax error points *before* the marked token', () => {
  const out = hint('42601', 'syntax error at or near "FROM"');
  assert.match(out, /`FROM`/);
  assert.match(out, /davor/, 'the position is where the parser stopped, not where the bug is');

  // The same claim is the whole value of the hint, so it has to survive: the
  // marked token is where the parser gave up, not where the mistake is.
  assert.match(inEnglish('42601', 'syntax error at or near "FROM"'), /before it/);
});

test('an unfinished statement is distinguished from a mistyped one', () => {
  assert.match(hint('42601', 'syntax error at end of input'), /hört mitten drin auf/);
});

test('GROUP BY gets the explanation the error message refuses to give', () => {
  const message =
    'column "kunden.nachname" must appear in the GROUP BY clause or be used in an aggregate function';
  const out = hint('42803', message);
  assert.match(out, /GROUP BY/);
  assert.match(out, /count\(\.\.\.\)/);

  // 42803 is the case ARCHITECTURE §8a singles out: Postgres restates the rule,
  // it does not explain it, so the English hint has to say something the English
  // error message does not already say.
  const translated = inEnglish('42803', message);
  assert.match(translated, /GROUP BY/);
  assert.notEqual(translated, message);
  assert.match(translated, /which of the combined values/);
});

test('a mistyped function is matched against the ones a beginner uses', () => {
  const out = hint('42883', 'function lenght(text) does not exist');
  assert.match(out, /Meintest du `length`\?/);
});

test('a missing operator is about types, and mentions the || a beginner wants', () => {
  const out = hint('42883', 'operator does not exist: text + integer');
  assert.match(out, /text \+ integer/);
  assert.match(out, /\|\|/);
});

test('WHERE on a non-boolean names the comparison that is missing', () => {
  const out = hint('42804', 'argument of WHERE must be type boolean, not type text');
  assert.match(out, /WHERE-Bedingung/);
  assert.match(out, /WHERE name = 'Muster'/);

  // The clause is a SQL keyword and is substituted, not translated — it has to
  // survive as `WHERE` in both.
  assert.match(inEnglish('42804', 'argument of WHERE must be type boolean, not type text'), /WHERE/);
});

test('a unique violation reads the value out of `detail`, not the message', () => {
  const out = hint('23505', 'duplicate key value violates unique constraint "kunden_pkey"', {
    detail: 'Key (id)=(1) already exists.',
  });
  assert.match(out, /Der Wert `1` für `id` ist schon vergeben\./);
});

test('a unique violation with no detail still says something true', () => {
  const out = hint('23505', 'duplicate key value violates unique constraint "kunden_pkey"');
  assert.match(out, /eindeutig/);
});

test('a foreign key names the table the row would have to exist in', () => {
  const out = hint(
    '23503',
    'insert or update on table "bestellungen" violates foreign key constraint "bestellungen_kunde_id_fkey"',
    { detail: 'Key (kunde_id)=(999) is not present in table "kunden".' },
  );
  assert.match(out, /In `kunden` gibt es keine Zeile mit `kunde_id` = `999`\./);
});

test('the delete direction of a foreign key is the opposite advice', () => {
  const out = hint(
    '23503',
    'update or delete on table "kunden" violates foreign key constraint "bestellungen_kunde_id_fkey" on table "bestellungen"',
    { detail: 'Key (id)=(1) is still referenced from table "bestellungen".' },
  );
  assert.match(out, /kann nicht weg/);
  assert.match(out, /`bestellungen`/);
});

test('not-null names both the column and its table', () => {
  const out = hint(
    '23502',
    'null value in column "nachname" of relation "kunden" violates not-null constraint',
  );
  assert.match(out, /`nachname`/);
  assert.match(out, /`kunden`/);
});

test('a check violation names the rule, which is where the student must look', () => {
  const out = hint(
    '23514',
    'new row for relation "kunden" violates check constraint "kunden_alter_check"',
  );
  assert.match(out, /`kunden_alter_check`/);
});

test('a bad literal names both the value and the type it was going into', () => {
  const out = hint('22P02', 'invalid input syntax for type integer: "abc"');
  assert.match(out, /`abc`/);
  assert.match(out, /`integer`/);
});

test('a bad date teaches the format rather than restating the error', () => {
  const out = hint('22008', 'date/time field value out of range: "2025-13-45"');
  assert.match(out, /`2025-04-03`/);

  // The date the hint teaches is ISO, which is neither locale's *display*
  // format — it is what Postgres accepts as a literal, and that does not move
  // between locales. `formats()` in `i18n.js` is the separate question of how a
  // date is *displayed*; this one is about what Postgres will parse.
  assert.match(inEnglish('22008', 'date/time field value out of range: "2025-13-45"'), /2025-04-03/);
});

test('division by zero offers the fix', () => {
  assert.match(hint('22012', 'division by zero'), /NULLIF/);
});

test('an ambiguous column is told how to disambiguate, with its own name in it', () => {
  const out = hint('42702', 'column reference "id" is ambiguous');
  assert.match(out, /`kunden\.id`/);

  // The substitution appears twice in this template, once inside a larger
  // backticked example. Both have to be filled.
  assert.match(inEnglish('42702', 'column reference "id" is ambiguous'), /`kunden\.id`/);
});

/**
 * 2BP01 — the CSV import's characteristic failure, and the one set of strings in
 * this file that did **not** come off a deployed server.
 *
 * They were taken from PGlite (PostgreSQL 18.3) with a real `CREATE VIEW` and a
 * real `DROP TABLE`, because no cluster existed on the machine the day this was
 * written. That is still Postgres's own error machinery rather than a composed
 * string, and this wording has been unchanged for many majors — but the
 * deployment runs 17, so if this ever fails after an upgrade, believe the server
 * and not the file. HANDOFF §5 carries it as unverified against 17.
 */
test('a drop blocked by a view names what is in the way', () => {
  const out = hint(
    '2BP01',
    'cannot drop table kunden because other objects depend on it',
    { detail: 'view kunden_zh depends on table kunden' },
  );
  assert.match(out, /`kunden`/);
  assert.match(out, /`kunden_zh`/);

  assert.match(
    inEnglish('2BP01', 'cannot drop table kunden because other objects depend on it', {
      detail: 'view kunden_zh depends on table kunden',
    }),
    /cannot be dropped/,
  );
});

test('several dependents are joined with the locale’s own conjunction', () => {
  const detail =
    'view b1 depends on table bestellungen\n' +
    'view b2 depends on table bestellungen\n' +
    'view b3 depends on table bestellungen';
  const message = 'cannot drop table bestellungen because other objects depend on it';

  assert.match(hint('2BP01', message, { detail }), /`b1`, `b2` oder `b3`/);
  assert.match(inEnglish('2BP01', message, { detail }), /`b1`, `b2` or `b3`/);
});

test('a name Postgres had to quote keeps its quotes, because the student must type them', () => {
  const out = hint(
    '2BP01',
    'cannot drop table "Meine Kunden" because other objects depend on it',
    { detail: 'view mk depends on table "Meine Kunden"' },
  );
  assert.match(out, /`"Meine Kunden"`/);
});

test('a detail line that does not parse costs the whole list, not one entry', () => {
  // Postgres appends "and N other objects (see server log for list)" past a
  // hundred dependents. Naming the ones it did list would read as the complete
  // set — the student removes those and hits the identical error again.
  const out = hint('2BP01', 'cannot drop table t because other objects depend on it', {
    detail: 'view v1 depends on table t\nand 137 other objects (see server log for list)',
  });
  assert.match(out, /`t`/);
  assert.doesNotMatch(out, /`v1`/);
});

test('no detail at all still explains the refusal', () => {
  const out = hint('2BP01', 'cannot drop table t because other objects depend on it');
  assert.match(out, /`t`/);
  assert.match(inEnglish('2BP01', 'cannot drop table t because other objects depend on it'), /view/);
});

// --- what the two locales owe each other -------------------------------------

test('a backtick in a table name cannot unbalance the rendered pairs', () => {
  // `plain()` strips it on the way out of the handler, so the caller's
  // backtick-to-<code> pass cannot be thrown off. HANDOFF §4kk is the security
  // probe that found the neighbouring bug.
  const out = hint('42P01', 'relation "ku`nden" does not exist');
  assert.equal((out.match(/`/g) ?? []).length % 2, 0, `unbalanced backticks: ${out}`);
  assert.doesNotMatch(out, /ku`nden/);
});

test('every hint renders in English without falling through to German', () => {
  // The per-case `assertTranslated` covers the shapes exercised above. This one
  // is the backstop for the codes that take no arguments and would otherwise be
  // asserted nowhere.
  for (const code of EXPLAINED) {
    const structured = hintFor({ code, message: 'unrecognised shape' }, CATALOG);
    if (structured === null) continue;
    assert.ok(
      Object.hasOwn(en, structured.key),
      `${code} -> ${structured.key} has no English string`,
    );
  }
});

// --- what it refuses to do ---------------------------------------------------

test('an unlisted SQLSTATE gets no hint at all', () => {
  // Silence is a real answer: the raw message still renders, and a plausible
  // German sentence about the wrong thing is worse than none.
  assert.equal(hint('XX000', 'internal error'), null);
  assert.equal(hint('53300', 'too many connections for role "u_x"'), null);
});

test('a listed SQLSTATE whose message is unrecognised also gets none', () => {
  // Postgres wording changes between major versions. The failure mode has to be
  // "no hint", never "a hint built from a regex that half-matched".
  assert.equal(hint('42P01', 'something entirely unanticipated'), null);
  assert.equal(hint('23502', 'null value somewhere'), null);
});

test('57014 is deliberately absent — the page already knows why it stopped', () => {
  assert.ok(!EXPLAINED.includes('57014'));
  assert.equal(hint('57014', 'canceling statement due to user request'), null);
});

test('a hint never throws, whatever the catalog looks like', () => {
  const message = 'relation "kunde" does not exist';
  for (const catalog of [null, undefined, {}, { schemas: null }, { schemas: [{}] }, 'nonsense']) {
    assert.doesNotThrow(() => hintFor({ code: '42P01', message }, catalog));
    assert.match(renderHint(hintFor({ code: '42P01', message }, catalog), german), /Die Tabelle `kunde`/);
  }
  assert.equal(hintFor(null), null);
  assert.equal(hintFor({ code: '42P01' }), null);
});

test('rendering nothing is nothing, not a crash', () => {
  // `renderHint(null)` is the normal path for every unlisted SQLSTATE — the
  // caller passes `hintFor`'s result straight in.
  assert.equal(renderHint(null, german), null);
});
