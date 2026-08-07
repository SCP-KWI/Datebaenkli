/**
 * The Markdown subset — phase 9. Pure, no db, no DOM.
 *
 * The first block is the reason this file exists. `renderMarkdown`'s output goes
 * into `innerHTML` on a pane a teacher fills and a class reads, so the failure
 * mode is an injection that renders identically to correct output — which is
 * exactly the thing nobody notices in a browser. Every case below is one way the
 * escape-first rule could be broken by a well-meaning edit.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/web/assets/markdown.js';

// --- the safety properties ---------------------------------------------------

test('markdown: raw HTML is text, never markup', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script'), html);
  assert.ok(html.includes('&lt;script&gt;'));
});

/**
 * Every `<` in the output is one this file wrote.
 *
 * Asserted as "the tags present are from the known set" rather than as "the
 * string `onerror=` does not appear": the escaped *text* `onerror=alert(1)` is
 * perfectly safe and is exactly what a task describing an XSS lesson would
 * contain. What must never appear is a tag we did not emit.
 */
const TAGS = /<\/?([a-z][a-z0-9]*)\b/gi;
const ALLOWED = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'strong', 'em', 'code', 'pre', 'hr', 'a',
]);

function tagsIn(html) {
  return [...html.matchAll(TAGS)].map((m) => m[1].toLowerCase());
}

test('markdown: an img with an onerror never becomes a tag', () => {
  for (const source of [
    '# <img src=x onerror=alert(1)>',
    '- <img src=x onerror=alert(1)>',
    '<img src=x onerror=alert(1)>',
    '```\n<img src=x onerror=alert(1)>\n```',
    '**<img src=x onerror=alert(1)>**',
    '`<img src=x onerror=alert(1)>`',
  ]) {
    const html = renderMarkdown(source);
    for (const tag of tagsIn(html)) {
      assert.ok(ALLOWED.has(tag), `${source} produced <${tag}> -> ${html}`);
    }
    assert.ok(html.includes('&lt;img'), `${source} -> ${html}`);
  }
});

test('markdown: a quote in a link target cannot break out of the href attribute', () => {
  // Two independent things stop this and the test is deliberately blind to
  // which: the href pattern rejects the space, and `esc()` has already turned
  // the quote into `&quot;` so it could not close the attribute either way.
  const html = renderMarkdown('[x](https://a" onmouseover="alert(1))');
  assert.ok(!html.includes('<a '), html);
  assert.ok(!html.includes('"a"'), html);
});

test('markdown: a link target with no space still cannot inject an attribute', () => {
  const html = renderMarkdown('[x](https://a"onmouseover="alert(1))');
  // It *is* a link — the pattern accepts it, stopping at the first `)` — and the
  // quotes are escaped, so the whole thing stays inside the href value where it
  // can do nothing. The escaping is the property; where the href happens to end
  // is not.
  assert.match(html, /^<p><a href="https:\/\/a&quot;onmouseover=&quot;alert\(1"/);
  assert.ok(!/href="[^"]*"\s+onmouseover/.test(html), html);
});

test('markdown: only http, https and mailto become links', () => {
  for (const href of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    '/relative/path',
  ]) {
    const html = renderMarkdown(`[click](${href})`);
    assert.ok(!html.includes('<a '), `${href} -> ${html}`);
  }
  assert.ok(renderMarkdown('[a](https://example.org)').includes('<a href="https://example.org"'));
  assert.ok(renderMarkdown('[a](mailto:x@example.org)').includes('<a href="mailto:x@example.org"'));
});

test('markdown: external links carry noopener', () => {
  // `target="_blank"` without it hands the opened page a `window.opener` it can
  // navigate back. Cheap, and invisible when missing.
  const html = renderMarkdown('[a](https://example.org)');
  assert.match(html, /rel="noopener noreferrer"/);
});

test('markdown: a NUL in the source cannot steer a code-span placeholder', () => {
  // NUL is the internal placeholder. A source carrying one would otherwise be
  // able to name a slot and pull a different code span into place.
  //
  // Written as `\u0000` rather than as a literal byte, for the reason
  // `markdown.js` gives at its own `NUL` constant and for one more: a literal
  // NUL makes git classify this whole file as **binary**, so it stops producing
  // diffs and stops being reviewable. Caught at `git show --stat`.
  const NUL = '\u0000';
  const html = renderMarkdown(`${NUL}0${NUL} and \`real\``);
  assert.ok(html.includes('<code>real</code>'), html);
  assert.ok(!html.includes(NUL), JSON.stringify(html));
});

// --- the formatting it does support -------------------------------------------

test('markdown: headings, one to six', () => {
  assert.equal(renderMarkdown('# Titel'), '<h1>Titel</h1>');
  assert.equal(renderMarkdown('###### klein'), '<h6>klein</h6>');
  // Seven hashes is not a heading; it is a paragraph starting with hashes.
  assert.match(renderMarkdown('####### zu tief'), /^<p>/);
});

test('markdown: paragraphs are separated by blank lines, not by newlines', () => {
  const html = renderMarkdown('eine Zeile\nnoch eine\n\nneuer Absatz');
  assert.equal(html, '<p>eine Zeile\nnoch eine</p>\n<p>neuer Absatz</p>');
});

test('markdown: bullet and numbered lists, and they close', () => {
  assert.equal(renderMarkdown('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
  // Switching kind closes the first list rather than nesting them.
  assert.equal(
    renderMarkdown('- a\n1. b'),
    '<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>',
  );
});

test('markdown: a list ends at a paragraph', () => {
  assert.equal(renderMarkdown('- a\n\nText'), '<ul>\n<li>a</li>\n</ul>\n<p>Text</p>');
});

test('markdown: bold, italic and inline code', () => {
  assert.equal(renderMarkdown('**fett**'), '<p><strong>fett</strong></p>');
  assert.equal(renderMarkdown('*kursiv*'), '<p><em>kursiv</em></p>');
  assert.equal(renderMarkdown('_kursiv_'), '<p><em>kursiv</em></p>');
  assert.equal(renderMarkdown('`SELECT 1`'), '<p><code>SELECT 1</code></p>');
});

test('markdown: bold wins over italic, so ** is not a * around a *', () => {
  assert.equal(renderMarkdown('**a**'), '<p><strong>a</strong></p>');
});

test('markdown: an underscore inside an identifier is not italic', () => {
  // The case that matters here: this app is full of `u_k3a_muster_lena` and
  // `bestellung_id`, and a renderer that italicises their middles is unusable.
  assert.equal(renderMarkdown('u_k3a_muster_lena'), '<p>u_k3a_muster_lena</p>');
  assert.equal(renderMarkdown('spalte_a und spalte_b'), '<p>spalte_a und spalte_b</p>');
});

test('markdown: a code span is not touched by the emphasis passes', () => {
  assert.equal(renderMarkdown('`a*b*c`'), '<p><code>a*b*c</code></p>');
  assert.equal(renderMarkdown('`a_b_c`'), '<p><code>a_b_c</code></p>');
});

test('markdown: a fence is literal, including markdown syntax inside it', () => {
  const html = renderMarkdown('```\n# nicht eine Überschrift\n- keine Liste\n```');
  assert.equal(html, '<pre><code># nicht eine Überschrift\n- keine Liste</code></pre>');
});

test('markdown: an unclosed fence still terminates at the end of the source', () => {
  assert.equal(renderMarkdown('```\nSELECT 1'), '<pre><code>SELECT 1</code></pre>');
});

test('markdown: a horizontal rule needs three, so two dashes stay text', () => {
  assert.equal(renderMarkdown('---'), '<hr />');
  assert.equal(renderMarkdown('--'), '<p>--</p>');
});

test('markdown: empty and nullish sources render nothing rather than throwing', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

test('markdown: a realistic task renders whole', () => {
  const html = renderMarkdown(
    [
      '# Bestellungen auswerten',
      '',
      'Finde heraus, **welche Kundin** am meisten bestellt hat.',
      '',
      '- Tabelle `kunden`',
      '- Tabelle `bestellungen`',
      '',
      'Tipp:',
      '',
      '```sql',
      'SELECT * FROM kunden;',
      '```',
    ].join('\n'),
  );
  assert.match(html, /<h1>Bestellungen auswerten<\/h1>/);
  assert.match(html, /<strong>welche Kundin<\/strong>/);
  assert.match(html, /<ul>\n<li>Tabelle <code>kunden<\/code><\/li>/);
  assert.match(html, /<pre><code>SELECT \* FROM kunden;<\/code><\/pre>/);
});
