/**
 * A very small Markdown subset, for the task text of an exercise — phase 9.
 *
 * ## Why this file exists at all
 *
 * A teacher writes the task in Markdown and twenty-five students read the
 * rendered result. That is untrusted-ish text going into `innerHTML`, which is
 * the one shape this app has otherwise avoided everywhere — and it is why this
 * is a module of its own rather than thirty lines inside `exercise.js`.
 * CLAUDE.md sets the bar for a fourth pure module as "this part can be wrong
 * without anyone seeing it, and a test can reach it". Both hold, and the way it
 * is wrong is an injection that renders identically to correct output.
 *
 * No dependency, for the reason `http/validate.ts` is hand-rolled and there is
 * no CSV parser: four runtime dependencies, and a Markdown library would be the
 * fifth for a feature that needs headings, lists, bold and code fences.
 *
 * ## The safety argument, which is the whole design
 *
 * **Everything is escaped first, and only then are tags inserted.** That is the
 * same order — and the same argument — as `util.js`'s `ticked()`: after `esc()`
 * there is no `<` left in the input to open a tag, so every `<` in the output is
 * one this file wrote. Doing it the other way round, or escaping "the parts that
 * need it", is an injection, and it is an injection that looks fine in testing
 * because nobody types a `<script>` into a task description by accident.
 *
 * Consequences worth stating, because each is a thing a future edit might
 * "improve":
 *
 *   - **Raw HTML in the source is never HTML.** `<b>hi</b>` renders as the
 *     literal text. That is not a limitation to be lifted; it is the property.
 *   - **Link targets are an allow-list**, `http:`, `https:` and `mailto:` only.
 *     A `[click](javascript:…)` renders as plain text rather than as a link.
 *     Escaping alone does not stop that one — `javascript:` contains nothing
 *     `esc()` touches.
 *   - **Code spans are extracted before any other inline pass** and put back
 *     afterwards, so `` `a*b*c` `` cannot have its middle italicised. The
 *     placeholder uses NUL, which `esc()` cannot produce and which the input has
 *     had stripped.
 *
 * ## What it does not do
 *
 * Tables, blockquotes, images, reference links, nested lists, setext headings,
 * HTML entities beyond escaping. A teacher wanting a table writes a code fence.
 * Adding any of them is fine; adding them by reaching for a library, or by
 * relaxing the escape-first rule, is not.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * A local copy rather than `util.js`'s `esc`.
 *
 * `test/markdown.test.mjs` imports this module under Node, where `util.js`'s
 * `wireThemeToggle` and `mountVersion` reach for `document`, `localStorage` and
 * `fetch` at call time — fine — but importing the module at all is one browser
 * global away from being a test that cannot run. The five replacements are
 * identical and the test asserts they are.
 */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * The code-span placeholder, written as an escape rather than as a literal
 * character: a bare NUL in a source file is invisible in every diff and every
 * editor, and this one is load-bearing.
 */
const NUL = '\u0000';

/** `http:`, `https:`, `mailto:`. Everything else is not a link. */
const SAFE_HREF = /^(https?:\/\/|mailto:)[^\s]+$/i;

/**
 * Inline formatting, applied to text that has **already** been escaped.
 *
 * Order: code spans out, then links, then bold, then italic, then code spans
 * back. Bold before italic because `**x**` would otherwise be read as an italic
 * `*` wrapping `x*`.
 */
function inline(escaped) {
  const codes = [];
  let out = escaped.replace(/`([^`]+)`/g, (_whole, body) => {
    codes.push(body);
    return `${NUL}${codes.length - 1}${NUL}`;
  });

  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, text, href) =>
    // `href` is already escaped, so it cannot carry a quote out of the
    // attribute. The test here is about the *scheme*, which escaping says
    // nothing about.
    SAFE_HREF.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : whole,
  );

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');

  return out.replace(new RegExp(`${NUL}(\\d+)${NUL}`, 'g'), (_whole, i) => `<code>${codes[Number(i)]}</code>`);
}

/**
 * Markdown source in, an HTML string out. Safe to assign to `innerHTML`.
 *
 * NUL is stripped before anything else: it is the code-span placeholder above,
 * and a source containing one could otherwise steer where a code span lands.
 * Nothing legitimate types one.
 */
export function renderMarkdown(source) {
  const lines = String(source ?? '')
    .replaceAll(NUL, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const html = [];
  let paragraph = [];
  /** `null`, `'ul'` or `'ol'` — which list, if any, is currently open. */
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(esc(paragraph.join('\n')))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list === null) return;
    html.push(`</${list}>`);
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // --- fenced code. Taken first and taken whole: everything up to the closing
    // fence is literal, which is what makes a fence the escape hatch for the
    // syntax this file does not support.
    const fence = /^\s*```/.exec(line);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      html.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(esc(heading[2].trim()))}</h${level}>`);
      continue;
    }

    // `---` on its own. Three or more, so a line of dashes under a heading (the
    // setext form this does not support) does not silently become a rule.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      html.push('<hr />');
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (list !== wanted) {
        flushList();
        html.push(`<${wanted}>`);
        list = wanted;
      }
      html.push(`<li>${inline(esc((bullet ?? numbered)[1]))}</li>`);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flush();
  return html.join('\n');
}
