/**
 * The translation layer (phase 6b) — the helper, and the two catalogues as data.
 *
 * Pure, no DOM: `i18n.js`'s `apply()` touches `document`, but only inside the
 * function, so the module imports fine under Node. That is the same bar
 * `names.js` and `hints.js` are held to, and the same reason — this is a part of
 * every page that can be quietly wrong for a whole term.
 *
 * **The catalogue tests are the point of this file.** A translation bug does not
 * throw and does not fail a build: a key present in German and missing in
 * English renders German on an English page, and looks like a styling
 * inconsistency to anyone who notices at all. Nobody on this project reads the
 * English pages daily, so the only thing that will catch it is an assertion.
 * Three classes of failure are checked below, all of them silent in production:
 * a missing key, a renamed substitution, and an unbalanced backtick.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;

const { translator, LOCALES, formats, load } = await import(dist('web/assets/i18n.js'));
const { default: de } = await import(dist('web/assets/i18n-de.js'));
const { default: en } = await import(dist('web/assets/i18n-en.js'));

// --- the helper --------------------------------------------------------------

test('a key resolves to its string, and substitutions are filled', () => {
  const t = translator({ greet: 'Hallo {name}!' });
  assert.equal(t('greet', { name: 'Lena' }), 'Hallo Lena!');
});

test('the same substitution can appear more than once', () => {
  // `hint.column.ambiguous` does exactly this — the column name, and then the
  // column name again inside a qualified example.
  const t = translator({ twice: '{x} und nochmals {x}' });
  assert.equal(t('twice', { x: 'id' }), 'id und nochmals id');
});

test('a missing key renders as the key, loudly', () => {
  // Not an empty string. A label that silently disappears is a bug that ships;
  // `roster.title` rendered on the page is a bug that gets reported the same day.
  const t = translator({});
  assert.equal(t('roster.title'), 'roster.title');
});

test('a placeholder with no value is left as written, not stringified to "undefined"', () => {
  // "undefined" mid-sentence reads as a translation someone wrote badly.
  // `{name}` reads as a bug, which is what it is.
  const t = translator({ greet: 'Hallo {name}!' });
  assert.equal(t('greet', {}), 'Hallo {name}!');
  assert.equal(t('greet', { other: 'x' }), 'Hallo {name}!');
});

test('English falls back to German rather than to the raw key', () => {
  // A half-swept catalogue degrades to a bilingual page. Ugly, readable, and
  // strictly better than `roster.students.none` in front of a class.
  const t = translator({ a: 'Alpha' }, { a: 'Alfa', b: 'Beta' });
  assert.equal(t('a'), 'Alpha');
  assert.equal(t('b'), 'Beta');
  assert.equal(t('c'), 'c');
});

test('has() distinguishes a missing key from one that renders as itself', () => {
  // The error map needs this: an unmapped `error.code` has to fall through to
  // the English developer message from the API, and `t()` returning the key is
  // not evidence either way.
  const t = translator({ 'error.quota_exceeded': 'error.quota_exceeded' });
  assert.equal(t.has('error.quota_exceeded'), true);
  assert.equal(t.has('error.nonesuch'), false);
});

test('has() sees through the fallback, because rendering does too', () => {
  const t = translator({}, { b: 'Beta' });
  assert.equal(t.has('b'), true);
});

test('a value with no substitutions is returned untouched', () => {
  const t = translator({ plain: 'Keine Platzhalter hier' });
  assert.equal(t('plain'), 'Keine Platzhalter hier');
  assert.equal(t('plain', {}), 'Keine Platzhalter hier');
});

// --- the catalogues, as data -------------------------------------------------

test('the two catalogues have exactly the same keys', () => {
  // The failure this catches is the silent one: German present, English absent,
  // renders in German on an English page and nobody files it. Both directions
  // are checked — an English key with no German is a key nothing can ever reach,
  // because German is what the fallback and the default resolve to.
  const missingEnglish = Object.keys(de).filter((key) => !Object.hasOwn(en, key));
  const orphanEnglish = Object.keys(en).filter((key) => !Object.hasOwn(de, key));

  assert.deepEqual(missingEnglish, [], 'keys in i18n-de.js with no English string');
  assert.deepEqual(orphanEnglish, [], 'keys in i18n-en.js that German does not have');
});

test('every string is a string, and none of them is empty', () => {
  for (const [name, catalog] of [['de', de], ['en', en]]) {
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, 'string', `${name}: ${key} is not a string`);
      assert.notEqual(value.trim(), '', `${name}: ${key} is empty`);
    }
  }
});

test('a translation uses exactly the substitutions its German original does', () => {
  // A renamed or dropped `{placeholder}` is invisible until the sentence renders
  // with a literal `{table}` in it — or, worse, silently drops the one piece of
  // information the student needed.
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  for (const [key, german] of Object.entries(de)) {
    if (!Object.hasOwn(en, key)) continue; // reported by the test above
    assert.deepEqual(
      placeholders(en[key]),
      placeholders(german),
      `${key}: the English string does not use the same substitutions`,
    );
  }
});

test('backticks are balanced, or a hint bleeds <code> across the panel', () => {
  // The page turns `` `x` `` into <code>x</code> after escaping. An odd number
  // in one string leaves a tag open and the rest of the error panel renders as
  // code. `hints.js` strips backticks out of substituted values for the same
  // reason; this is the half a translator can break.
  for (const [name, catalog] of [['de', de], ['en', en]]) {
    for (const [key, value] of Object.entries(catalog)) {
      const count = (value.match(/`/g) ?? []).length;
      assert.equal(count % 2, 0, `${name}: ${key} has an unbalanced backtick`);
    }
  }
});

test('the German catalogue is Swiss: no ß anywhere', () => {
  // CLAUDE.md and hints.js's header both say it; this is the one that notices.
  // `gross`, `heisst`, `schliessen`, `verstösst`.
  const offenders = Object.entries(de)
    .filter(([, value]) => value.includes('ß'))
    .map(([key]) => key);
  assert.deepEqual(offenders, [], 'ß in a Swiss school app');
});

test('every error code the server can send has a translation', () => {
  // Read out of `http/errors.ts` rather than duplicated here, because a
  // duplicated list is a list that goes stale: the failure mode is somebody
  // adding a `ServiceError` code next term and a student reading the English
  // developer string in a German lesson. `errorText()` degrades to exactly that,
  // deliberately — this test is what stops the degradation being permanent.
  //
  // Source-reading in a test has the `sql.test.mjs` precedent (it parses the
  // migrations). The alternative, importing the compiled module, would only give
  // the object back if it were exported, and it is private on purpose.
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'http', 'errors.ts'),
    'utf8',
  );
  // The closing brace may carry a `)` because the table is built with
  // `Object.assign(Object.create(null), { … })` — a prototype-less map, so that
  // a code like `constructor` cannot resolve to an inherited function. The
  // `codes.length > 20` assertion below is the real guard against this regex
  // silently matching nothing useful; the shape of the declaration is allowed
  // to move as long as that still holds.
  const table = /const SERVICE_ERROR_STATUS[^{]*\{([\s\S]*?)\n\}\)?;/.exec(source);
  assert.ok(table, 'could not find SERVICE_ERROR_STATUS — did errors.ts move?');

  const codes = [...table[1].matchAll(/^\s{2}(\w+):\s*\d+,/gm)].map((m) => m[1]);
  assert.ok(codes.length > 20, `only found ${codes.length} codes; the regex has drifted`);

  // The four `HttpError` helpers at the top of the same file, which are not in
  // that table and are just as visible to a student.
  const untranslated = [...codes, 'unauthenticated', 'forbidden', 'not_found', 'internal'].filter(
    (code) => !Object.hasOwn(de, `error.${code}`),
  );
  assert.deepEqual(untranslated, [], 'error codes with no entry in i18n-de.js');
});

test('the region stays Swiss in both locales, and only the language moves', async () => {
  // This is the decision from HANDOFF §4mm, and it is the one a future sweep is
  // most likely to undo by "consistency": mapping `en` to `en-US` or to the
  // browser's own locale would put the month before the day in a Swiss
  // classroom, and would make two students side by side see different numbers.
  // Both of those are silent — nothing throws, the page just quietly disagrees
  // with the one at the next desk.
  // Local components, **not** `Date.UTC`, and a day past the 12th. Both matter.
  //
  // `toLocale*` renders in the process zone, so a UTC instant lands on a
  // different calendar day depending on `TZ` — `Date.UTC(2026, 2, 25, 12)` is
  // the 26th in Auckland, and no single instant is safe across a 26-hour spread
  // of zones. Building from local components pins the *rendered* date instead,
  // which is what is actually under test. §4l is the same hazard one layer down,
  // and the reason this file must not become a report on `TZ`.
  //
  // A day ≤ 12 could not distinguish day-first from month-first, which is the
  // property being asserted at all. Nothing below pins an absolute hour.
  const sample = new Date(2026, 2, 25, 12, 0, 0);

  await load('de');
  assert.equal(formats().tag, 'de-CH');
  const german = { n: formats().number.format(1234.5), t: formats().time(sample) };

  await load('en');
  // Also the proof that `load()` clears the memoised formatters: these are
  // cached because `renderTree()` formats a row estimate per table, and a stale
  // cache would show German numbers on an otherwise English page.
  assert.equal(formats().tag, 'en-CH');
  const english = { n: formats().number.format(1234.5), t: formats().time(sample) };

  // The requirement, asserted as a *relation* rather than as literal glyphs: the
  // group separator CLDR uses for `de-CH` has changed between ICU versions
  // (U+0027 vs U+2019), so pinning the character would make this test a report
  // on the Node build. What must hold is that both locales agree.
  assert.equal(english.n, german.n, 'the two locales format numbers differently');
  assert.equal(english.t, german.t, 'the two locales format the clock differently');

  // And that it is still Swiss: grouped thousands, a dot decimal, 24-hour time.
  assert.match(german.n, /^1\D234\.5$/);
  assert.match(german.t, /^\d{1,2}:\d{2}:\d{2}$/, `not a 24-hour clock: ${german.t}`);
  assert.doesNotMatch(german.t, /[AP]\.?M/i, `an am/pm clock: ${german.t}`);

  // Dates are the one place the two legitimately differ — `en-CH` zero-pads —
  // so what is asserted is that both stay **day-first**, which is the part that
  // would actually mislead a Swiss classroom if it moved. `en-US` gives
  // `3/25/2026` and would fail here, which is the point.
  await load('de');
  const deDate = formats().date(sample);
  await load('en');
  const enDate = formats().date(sample);
  assert.match(deDate, /^25\.0?3\.2026$/, `de-CH date was ${deDate}`);
  assert.match(enDate, /^25[./]0?3[./]2026$/, `en-CH date was ${enDate}`);

  await load('de');
});

test('LOCALES matches what the database will accept', () => {
  // `app_user_locale_ck` is `CHECK (locale IN ('de', 'en'))`. A locale offered
  // in a dropdown that the CHECK refuses is a 400 on a click that looks fine.
  assert.deepEqual(LOCALES, ['de', 'en']);
});
