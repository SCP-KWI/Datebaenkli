/**
 * CSV parsing, Swiss-format coercion, type inference and identifier folding.
 * Pure logic, no database — everything here runs in milliseconds.
 *
 * The claims worth pinning are the ones a mock could never have caught and a
 * live server would report far too late: that `03.04.2025` becomes 3 April and
 * not 4 March, that `1'234,50` is a number, and that a column of `0`/`1` is
 * *not* inferred as a boolean. Each of those is a silent wrong answer rather
 * than an error, which is the kind this file exists for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;

process.env.DBK_ENCRYPTION_KEY ??= Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
process.env.DBK_SESSION_SECRET ??= 'test-session-secret-0123456789abcdefghijklmnop';
process.env.DBK_APP_DB_PASSWORD ??= 'test';

const { parseCsv, coerce, inferType, inferColumns } = await import(dist('services/csv.js'));
const { foldRelationName, previewCsv, MAX_IMPORT_ROWS } = await import(dist('services/import.js'));

// --- the record splitter -----------------------------------------------------

test('splits quoted fields holding delimiters, newlines and doubled quotes', () => {
  const csv = 'a;b\n"x;y";"line1\nline2"\n"say ""hi""";plain\n';
  const parsed = parseCsv(csv, { delimiter: ';', hasHeader: true });

  assert.deepEqual(parsed.header, ['a', 'b']);
  assert.deepEqual(parsed.rows, [
    ['x;y', 'line1\nline2'],
    ['say "hi"', 'plain'],
  ]);
});

test('a quote that does not open a field is just a character', () => {
  // `5" Schraube` is data, not a parse error. A strict RFC 4180 reader would
  // reject the file and tell a student nothing they can act on.
  const parsed = parseCsv('mass\n5" Schraube\n', { delimiter: ';', hasHeader: true });
  assert.deepEqual(parsed.rows, [['5" Schraube']]);
});

test('CRLF, a trailing newline and blank lines in the middle', () => {
  const parsed = parseCsv('a;b\r\n1;2\r\n\r\n3;4\r\n', { hasHeader: true });
  assert.deepEqual(parsed.rows, [
    ['1', '2'],
    ['3', '4'],
  ]);
  assert.equal(parsed.totalRows, 2);
});

test('a BOM does not become part of the first column name', () => {
  // Left in place it produces a column called `﻿id`: invisible everywhere,
  // and impossible to type in SQL.
  const parsed = parseCsv('﻿id;name\n1;Lena\n', { hasHeader: true });
  assert.deepEqual(parsed.header, ['id', 'name']);
});

test('ragged rows are padded, not rejected', () => {
  const parsed = parseCsv('a;b;c\n1;2\n1;2;3;4\n', { delimiter: ';', hasHeader: true });
  // The widest record sets the width, so the fourth value is not thrown away —
  // and the short row is padded out to match rather than rejected.
  assert.equal(parsed.header.length, 4);
  assert.deepEqual(parsed.rows[0], ['1', '2', '', '']);
  assert.deepEqual(parsed.rows[1], ['1', '2', '3', '4']);
});

test('line numbers survive blank lines and newlines inside quoted fields', () => {
  // The whole reason `lines` is tracked rather than computed as index + 2.
  const csv = 'a;b\n1;"two\nlines"\n\n3;4\n';
  const parsed = parseCsv(csv, { delimiter: ';', hasHeader: true });
  assert.deepEqual(parsed.lines, [2, 5]);
});

// --- delimiter sniffing ------------------------------------------------------

test('sniffs the delimiter that makes the file rectangular', () => {
  assert.equal(parseCsv('a;b;c\n1;2;3\n').delimiter, ';');
  assert.equal(parseCsv('a,b,c\n1,2,3\n').delimiter, ',');
  assert.equal(parseCsv('a\tb\tc\n1\t2\t3\n').delimiter, '\t');
});

test('a semicolon file whose text fields contain commas still sniffs as semicolon', () => {
  // The case that matters: Excel de-CH writes `;`, and German prose is full of
  // commas. Scoring on consistency rather than raw count is what gets this right.
  const csv = 'name;bemerkung\nLena;kurz, aber gut\nTim;ja, sicher\nAna;nein, danke\n';
  assert.equal(parseCsv(csv).delimiter, ';');
});

// --- Swiss numbers -----------------------------------------------------------

test('Swiss thousands separators and the decimal comma', () => {
  // `'` is the de-CH group separator; U+2019 is what it becomes after Excel or
  // Word autocorrects it, and the two are indistinguishable on screen.
  assert.equal(coerce("1'234'567", 'integer', true), '1234567');
  assert.equal(coerce('1’234', 'integer', true), '1234');
  assert.equal(coerce('1234,50', 'numeric', true), '1234.50');
  assert.equal(coerce("1'234,50", 'numeric', true), '1234.50');
});

test('a comma-delimited file cannot have a decimal comma', () => {
  // `"1,234"` in a comma-delimited file came through quoting and can only be
  // grouping. Reading it as 1.234 would be off by a factor of a thousand.
  assert.equal(coerce('1,234', 'numeric', false), '1234');
  assert.equal(coerce('1,234', 'numeric', true), '1.234');
});

test('both separators present: the last one is the decimal mark', () => {
  assert.equal(coerce('1,234.50', 'numeric', true), '1234.50');
  assert.equal(coerce('1.234,50', 'numeric', true), '1234.50');
});

test('integer range is checked here, not at the database', () => {
  // Otherwise a single overflowing id fails the whole import with a 22003 and
  // no indication of which row it came from.
  assert.equal(coerce('2147483647', 'integer', true), '2147483647');
  assert.equal(coerce('2147483648', 'integer', true), undefined);
  assert.equal(coerce('2147483648', 'bigint', true), '2147483648');
  assert.equal(coerce('9223372036854775808', 'bigint', true), undefined);
});

// --- dates -------------------------------------------------------------------

test('a Swiss date is normalised to ISO, not handed to Postgres as written', () => {
  // The trap this whole coercion layer exists for. Postgres's default DateStyle
  // is `ISO, MDY`, under which `03.04.2025` parses without error as March 4th.
  assert.equal(coerce('03.04.2025', 'date', true), '2025-04-03');
  assert.equal(coerce('3.4.2025', 'date', true), '2025-04-03');
  assert.equal(coerce('2025-04-03', 'date', true), '2025-04-03');
});

test('a two-digit year pivots at 70, as Postgres does', () => {
  assert.equal(coerce('01.01.69', 'date', true), '2069-01-01');
  assert.equal(coerce('01.01.70', 'date', true), '1970-01-01');
});

test('slash dates are deliberately not dates', () => {
  // `03/04/2025` is 3 April here and 4 March to Postgres, and nothing in the
  // file says which the student meant. Falling through to text is the only
  // answer that cannot be silently wrong.
  assert.equal(coerce('03/04/2025', 'date', true), undefined);
  assert.equal(inferType(['03/04/2025', '04/05/2025'], true), 'text');
});

test('the calendar is checked, so 31.02 is not a date', () => {
  assert.equal(coerce('31.02.2025', 'date', true), undefined);
  assert.equal(coerce('29.02.2024', 'date', true), '2024-02-29');
});

test('timestamps take a space or a T, and reject impossible clock times', () => {
  assert.equal(coerce('03.04.2025 14:30', 'timestamp', true), '2025-04-03 14:30:00');
  assert.equal(coerce('2025-04-03T14:30:05', 'timestamp', true), '2025-04-03 14:30:05');
  assert.equal(coerce('03.04.2025 25:00', 'timestamp', true), undefined);
});

// --- inference ---------------------------------------------------------------

test('a column of 0 and 1 is an integer, not a boolean', () => {
  // Inference must be conservative: a flag misread as an id costs one dropdown,
  // an id column silently turned into true/false is unrecoverable.
  assert.equal(inferType(['0', '1', '1', '0'], true), 'integer');
  // But an explicit choice is honoured, because then the student has said so.
  assert.equal(coerce('1', 'boolean', true), 'true');
  assert.equal(coerce('0', 'boolean', true), 'false');
});

test('German boolean words are inferred', () => {
  assert.equal(inferType(['ja', 'nein', 'ja'], true), 'boolean');
  assert.equal(inferType(['wahr', 'falsch'], true), 'boolean');
});

test('an all-blank column is text, not vacuously the narrowest type', () => {
  assert.equal(inferType(['', '  ', ''], true), 'text');
});

test('blanks are ignored by inference and become NULL', () => {
  assert.equal(inferType(['1', '', '3'], true), 'integer');
  assert.equal(coerce('', 'integer', true), null);
  assert.equal(coerce('   ', 'date', true), null);
});

test('one bad value widens the whole column to text', () => {
  assert.equal(inferType(['1', '2', 'unbekannt'], true), 'text');
});

test('inference runs per column across a real file', () => {
  const csv = [
    'id;name;preis;geliefert;datum',
    "1;Schraube;1'234,50;ja;03.04.2025",
    '2;Mutter;9,90;nein;04.04.2025',
  ].join('\n');
  const parsed = parseCsv(csv);
  assert.equal(parsed.delimiter, ';');
  assert.deepEqual(
    inferColumns(parsed).map((c) => c.type),
    ['integer', 'text', 'numeric', 'boolean', 'date'],
  );
});

// --- header detection --------------------------------------------------------

test('a header of words above rows of numbers is detected', () => {
  assert.equal(parseCsv('id;preis\n1;9.90\n2;4.50\n').hasHeader, true);
});

test('a file of nothing but numbers has no header', () => {
  assert.equal(parseCsv('1;2;3\n4;5;6\n').hasHeader, false);
});

// --- identifier folding ------------------------------------------------------

test('folds a human name into something typeable, keeping word boundaries', () => {
  // `fold()` alone strips separators, which would give `umsaetze2025` — the
  // reason foldRelationName splits first and rejoins with underscores.
  assert.equal(foldRelationName('Umsätze 2025'), 'umsaetze_2025');
  assert.equal(foldRelationName('first name'), 'first_name');
  assert.equal(foldRelationName('preis.chf'), 'preis_chf');
  assert.equal(foldRelationName('Grüezi-Wohl'), 'grueezi_wohl');
});

test('a name starting with a digit gets an underscore', () => {
  // Legal quoted, a syntax error unquoted — and unquoted is how a student
  // will type it in the editor afterwards.
  assert.equal(foldRelationName('2025 Umsatz'), '_2025_umsatz');
});

test('folding cannot produce anything outside [a-z_][a-z0-9_]*', () => {
  const nasty = ['"; DROP TABLE x; --', "o'brien", 'a b', '../../etc', '<script>'];
  for (const input of nasty) {
    const folded = foldRelationName(input);
    assert.ok(
      folded === '' || /^[a-z_][a-z0-9_]{0,62}$/.test(folded),
      `${JSON.stringify(input)} folded to ${JSON.stringify(folded)}`,
    );
  }
});

test('a name that folds away entirely comes back empty for the caller to handle', () => {
  assert.equal(foldRelationName('   '), '');
  assert.equal(foldRelationName('...'), '');
});

// --- the preview -------------------------------------------------------------

test('the preview names the table after the file, without the extension', () => {
  const preview = previewCsv('id;name\n1;Lena\n', 'Meine Kunden.csv');
  assert.equal(preview.table, 'meine_kunden');
  // The extension strip must not apply to columns: `preis.chf` is a header.
  assert.deepEqual(
    previewCsv('preis.chf;x\n1;2\n').columns.map((c) => c.name),
    ['preis_chf', 'x'],
  );
});

test('colliding headers are suffixed rather than dropped', () => {
  // `Name` and `NAME` are two ordinary spreadsheet headers and one identifier.
  const preview = previewCsv('Name;NAME;name\n1;2;3\n');
  assert.deepEqual(
    preview.columns.map((c) => c.name),
    ['name', 'name_2', 'name_3'],
  );
  // The originals are kept so the student recognises their own file.
  assert.deepEqual(
    preview.columns.map((c) => c.sourceName),
    ['Name', 'NAME', 'name'],
  );
});

test('an empty header cell becomes a positional name', () => {
  const preview = previewCsv('id;;name\n1;2;3\n');
  assert.deepEqual(
    preview.columns.map((c) => c.name),
    ['id', 'spalte2', 'name'],
  );
});

test('the preview clips its sample but reports the true total', () => {
  const rows = Array.from({ length: 100 }, (_, i) => `${i};x`).join('\n');
  const preview = previewCsv(`id;name\n${rows}\n`);
  assert.equal(preview.rows.length, 20);
  assert.equal(preview.totalRows, 100);
  assert.equal(preview.truncated, true);
  assert.equal(preview.tooManyRows, false);
});

test('a file with no rows at all does not throw', () => {
  const preview = previewCsv('', 'leer.csv');
  assert.deepEqual(preview.columns, []);
  assert.equal(preview.totalRows, 0);
  assert.equal(preview.table, 'leer');
});

test('the row cap is reported rather than silently applied', () => {
  const parsed = parseCsv(`id\n${Array.from({ length: 50 }, (_, i) => i).join('\n')}\n`, {
    maxRows: 10,
  });
  assert.equal(parsed.rows.length, 10);
  assert.equal(parsed.totalRows, 50, 'the true count keeps going past the cap');
  assert.equal(parsed.truncated, true);
  assert.ok(MAX_IMPORT_ROWS > 0);
});
