/**
 * Two copies of one dialog, on disk — phase 9. No db, no DOM.
 *
 * `test/chalk.test.mjs`'s trick, applied to the second thing in this repo that
 * is deliberately duplicated. `routes/pages.ts` serves every page as a
 * byte-for-byte constant and has no template engine on purpose, so the CSV
 * import dialog's markup exists twice — once in `sql.html`, once in
 * `uebungen.html` — while `csv-import.js` drives both from one implementation.
 *
 * That is fine right up until somebody adds a field to one of them. The copy
 * that was not edited then has an element `csv-import.js` reaches for and does
 * not find, on whichever page nobody happened to open. This is the assertion
 * that turns that into a failing test instead.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const WEB = join(import.meta.dirname, '..', 'src', 'web');
const read = (name) => readFileSync(join(WEB, name), 'utf8');

/** The `<dialog id="importDialog">` block, verbatim, indentation and all. */
function importDialog(html) {
  const open = html.indexOf('<dialog id="importDialog">');
  assert.notEqual(open, -1, 'no import dialog in this page');
  const close = html.indexOf('</dialog>', open);
  assert.notEqual(close, -1, 'unterminated import dialog');
  return html.slice(open, close + '</dialog>'.length);
}

test('pages: the import dialog is identical in sql.html and uebungen.html', () => {
  assert.equal(importDialog(read('sql.html')), importDialog(read('uebungen.html')));
});

test('pages: the import dialog carries every id csv-import.js reaches for', () => {
  // Read out of the module rather than listed here: a list would be a third
  // copy, and the one that goes stale silently.
  const script = readFileSync(join(WEB, 'assets', 'csv-import.js'), 'utf8');
  const ids = [...script.matchAll(/\bel\('([A-Za-z]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 5, 'expected to find the dialog ids in csv-import.js');

  for (const page of ['sql.html', 'uebungen.html']) {
    const html = read(page);
    for (const id of new Set(ids)) {
      assert.ok(html.includes(`id="${id}"`), `${page} is missing id="${id}"`);
    }
  }
});

test('pages: every page carries the Chalk head and a theme script', () => {
  // `theme.js` must be a classic script and must run before first paint; a page
  // added without it is a page that flashes white for every dark-mode reader.
  for (const page of [
    'home.html',
    'login.html',
    'password.html',
    'sql.html',
    'lesson.html',
    'roster.html',
    'uebungen.html',
  ]) {
    const html = read(page);
    assert.ok(html.includes('<script src="/assets/theme.js"></script>'), `${page}: no theme.js`);
    assert.ok(html.includes('/assets/chalk-tokens.css'), `${page}: no design tokens`);
    assert.ok(html.includes('/assets/app.css'), `${page}: no stylesheet`);
  }
});

test('pages: no inline event handlers or inline scripts survive', () => {
  // `script-src 'self'` and `style-src 'self'` in server.ts are only worth
  // having while this is true. Both were paid for once (phase 8.2); a new page
  // is the obvious way to spend it back.
  for (const page of ['home.html', 'sql.html', 'uebungen.html', 'lesson.html', 'roster.html']) {
    const html = read(page);
    assert.ok(!/\son[a-z]+\s*=/.test(html.replace(/<!--[\s\S]*?-->/g, '')), `${page}: inline handler`);
    assert.ok(!/<script(?![^>]*\ssrc=)/.test(html), `${page}: inline <script>`);
    assert.ok(!/\sstyle="/.test(html), `${page}: inline style`);
  }
});
