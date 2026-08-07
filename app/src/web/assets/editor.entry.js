/**
 * The editor bundle's entry point — the only file in this project that is
 * bundled, and the reason `esbuild` exists in devDependencies.
 *
 * CodeMirror 6 ships as two dozen ESM packages with bare specifiers, so it
 * cannot be served straight to a browser the way `sql.js` and the HTML pages
 * are. Everything CodeMirror-shaped is therefore confined to this file, behind
 * one plain function; `sql.js` imports `createEditor` and knows nothing else
 * about the library. If CodeMirror is ever swapped out, this is the file to
 * rewrite and the only one.
 *
 * The build output is `dist/web/assets/editor.js`. It is a build artefact, not
 * a vendored blob — nothing minified is committed to a public repository.
 */

import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { Compartment, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, keymap } from '@codemirror/view';
import { EditorView, basicSetup } from 'codemirror';

/** Replaces the whole SQL language support when a fresh catalog arrives. */
const language = new Compartment();

const showError = StateEffect.define();
const errorMark = Decoration.mark({ class: 'cm-sqlError' });

/**
 * The squiggle under the character Postgres complained about.
 *
 * Cleared by the next edit rather than left to drift: once the text has
 * changed, the offset the server sent no longer points at anything the server
 * ever saw, and an underline in the wrong place is worse than none.
 */
const errorField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(showError)) {
        return effect.value === null
          ? Decoration.none
          : Decoration.set([errorMark.range(effect.value.from, effect.value.to)]);
      }
    }
    return tr.docChanged ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Postgres reports the error position as a 1-based *character* offset; a
 * CodeMirror document is indexed in UTF-16 code units. They agree for anything
 * in the BMP, which covers every character a lesson will produce — an emoji in
 * a string literal would shift the squiggle by one, and that is the whole cost.
 *
 * The mark runs to the end of the identifier rather than covering one
 * character, because "syntax error at or near FRM" wants the word underlined.
 */
function markRange(doc, position) {
  const from = Math.max(0, Math.min(position - 1, doc.length));
  const line = doc.lineAt(from);
  const word = /^[\w$]+/.exec(line.text.slice(from - line.from));
  return { from, to: word ? from + word[0].length : Math.min(from + 1, line.to) };
}

/**
 * Background and text are inherited rather than set.
 *
 * Since phase 7 the page's colours come from `chalk-tokens.css` and the
 * `data-theme` attribute, so `--paper` and `--ink` are what these inherit from;
 * a theme with its own background would be a white slab in a dark window. Syntax
 * colours stay CodeMirror's defaults, which read acceptably against both.
 *
 * **This covers the editor and nothing else.** CodeMirror's floating UI — the
 * autocomplete popup, the search panel — is themed separately and keeps its own
 * white background unless told otherwise, which inheriting a near-white `--ink`
 * in dark mode turns into white-on-white. Those rules live in `app.css` under
 * the `.cm-tooltip` banner, and that banner explains the trap. **If you add a
 * CodeMirror surface that floats, it needs a background there — inheriting is
 * only safe for things that sit inside the editor.**
 */
const inheritPageColours = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'inherit' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'currentColor' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'inherit', opacity: '0.5', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, currentColor 6%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'currentColor' },
  // `var(--bad)` rather than a hex: the wavy underline is the app's error red,
  // and the token is the only copy of that colour that has a dark variant.
  '.cm-sqlError': { textDecoration: 'underline wavy var(--bad)', textUnderlineOffset: '0.25em' },
});

/**
 * Mount an editor into `parent`.
 *
 * `onRun` is bound at the highest precedence so it wins over anything
 * `basicSetup` binds to the same chord now or in a future version — the Run
 * key is the one interaction the whole page exists for.
 */
export function createEditor({ parent, doc = '', onRun }) {
  const run = () => {
    onRun();
    return true;
  };

  const view = new EditorView({
    parent,
    doc,
    extensions: [
      basicSetup,
      language.of(sql({ dialect: PostgreSQL })),
      errorField,
      inheritPageColours,
      Prec.highest(
        keymap.of([
          { key: 'Mod-Enter', run },
          // A Swiss school keyboard is not guaranteed to have a comfortable
          // Ctrl-Enter under every browser's shortcut set; Shift-Enter is the
          // spare, and neither inserts a newline once bound.
          { key: 'Shift-Enter', run },
        ]),
      ),
    ],
  });

  return {
    getValue: () => view.state.doc.toString(),
    focus: () => view.focus(),

    /**
     * Replace the whole document — used by the schema browser's table click.
     *
     * Appending was tried first and is worse in a way that is not obvious:
     * because a script is sent as one simple-protocol message, Postgres wraps
     * it in a single implicit transaction, so one piece of broken SQL left
     * behind in the editor makes *every* subsequent table click fail with an
     * error about text the student is no longer looking at.
     *
     * Replacing is destructive, but it is a normal CodeMirror transaction, so
     * ⌘Z puts the previous text back. Reversible beats cautious.
     */
    setValue(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      view.focus();
    },

    /**
     * Re-point autocomplete at the caller's catalog.
     *
     * `defaultSchema` is what makes `SELECT * FROM kunden` complete without the
     * `u_k3a_muster_lena.` prefix — Postgres resolves it through `search_path`
     * ("$user", public), so the editor should too.
     */
    setCatalog(schema, defaultSchema) {
      view.dispatch({
        effects: language.reconfigure(sql({ dialect: PostgreSQL, schema, defaultSchema })),
      });
    },

    /** `position` is Postgres's 1-based offset, or null to clear the mark. */
    markError(position) {
      const value = position === null ? null : markRange(view.state.doc, position);
      view.dispatch({ effects: showError.of(value) });
      if (value !== null) view.dispatch({ selection: { anchor: value.from }, scrollIntoView: true });
    },
  };
}
