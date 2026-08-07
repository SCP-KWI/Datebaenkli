/**
 * Splitting a pasted class list into first and last names.
 *
 * Pure logic, no database and no DOM — this is the only part of phase 5's
 * roster page that can be tested without a browser, and it is also the only
 * part whose mistakes are permanent: identifiers are never re-issued, so a line
 * parsed the wrong way round is `u_k3a_lena_muster` for the life of the
 * account. Every case below is a *silent* wrong answer rather than an error,
 * which is the kind this file exists for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;

const { parseLine, parseNames } = await import(dist('web/assets/names.js'));

test('the order select decides, because nothing else can', () => {
  assert.deepEqual(parseLine('Muster Lena', 'last-first'), {
    lastName: 'Muster',
    firstName: 'Lena',
  });
  assert.deepEqual(parseLine('Muster Lena', 'first-last'), {
    firstName: 'Muster',
    lastName: 'Lena',
  });
});

test('a comma overrides the order, in both directions', () => {
  // "Nachname, Vorname" is universal enough that honouring the select here
  // would produce a wrong answer from a correctly formatted list.
  for (const order of ['last-first', 'first-last']) {
    assert.deepEqual(parseLine('Muster, Lena', order), {
      lastName: 'Muster',
      firstName: 'Lena',
    });
  }
});

test('a third comma field is dropped, not welded into the surname', () => {
  // "Nachname, Vorname, Klasse" from a CSV opened as text. Requiring exactly two
  // fields sent this down the space-splitting path with the commas still in it,
  // producing the surname "Muster, Lena," and the first name "3a".
  assert.deepEqual(parseLine('Muster, Lena, 3a', 'last-first'), {
    lastName: 'Muster',
    firstName: 'Lena',
  });
  assert.deepEqual(parseLine('Muster, Lena, lena.muster@example.ch', 'first-last'), {
    lastName: 'Muster',
    firstName: 'Lena',
  });
});

test('the comma is the only way to say "two first names"', () => {
  // Found by driving the deployed page: "Diego Armando Maradona" and "Von Gunten
  // Anna" are the same string shape, so the space heuristic cannot tell them
  // apart and gives the remainder to the surname. That is the documented trade,
  // and this is the escape hatch out of it — the case the placeholder now shows.
  assert.deepEqual(parseLine('Diego Armando Maradona', 'first-last'), {
    firstName: 'Diego',
    lastName: 'Armando Maradona',
  });
  assert.deepEqual(parseLine('Maradona, Diego Armando', 'last-first'), {
    lastName: 'Maradona',
    firstName: 'Diego Armando',
  });
});

test('a multi-word surname stays whole', () => {
  // The reason the remainder goes to the surname: "Von" is not a first name,
  // and this school has these names.
  assert.deepEqual(parseLine('Von Gunten Anna', 'last-first'), {
    lastName: 'Von Gunten',
    firstName: 'Anna',
  });
  assert.deepEqual(parseLine('Anna Von Gunten', 'first-last'), {
    firstName: 'Anna',
    lastName: 'Von Gunten',
  });
});

test('two tab-separated columns are two Excel columns, not a surname with a space', () => {
  // The trap: collapsing whitespace first turns "Von Gunten\tAnna" into three
  // space-separated words, and the surname loses its second half.
  assert.deepEqual(parseLine('Von Gunten\tAnna', 'last-first'), {
    lastName: 'Von Gunten',
    firstName: 'Anna',
  });
  assert.deepEqual(parseLine('Anna\tVon Gunten', 'first-last'), {
    firstName: 'Anna',
    lastName: 'Von Gunten',
  });
});

test('a single word is a surname with no first name, and says so', () => {
  // Not an error here: the page shows it as a missing first name and refuses to
  // submit, which is a correction the teacher can make. Guessing would put the
  // wrong string into an identifier that can never be changed.
  assert.deepEqual(parseLine('Muster', 'last-first'), { lastName: 'Muster', firstName: '' });
});

test('blank and whitespace-only lines disappear rather than becoming empty people', () => {
  assert.equal(parseLine('   ', 'last-first'), null);
  const people = parseNames('Muster Lena\n\n  \nMeier Tim\n', 'last-first');
  assert.equal(people.length, 2);
  assert.deepEqual(people.map((p) => p.lastName), ['Muster', 'Meier']);
});

test('a list pasted with trailing spaces and CRLF still parses', () => {
  // Windows clipboards are the normal case here, not the exotic one.
  const people = parseNames('Muster Lena \r\nMeier  Tim\r\n', 'last-first');
  assert.deepEqual(people, [
    { lastName: 'Muster', firstName: 'Lena' },
    { lastName: 'Meier', firstName: 'Tim' },
  ]);
});
