/**
 * The no-flash theme, phase 7 (Chalk design system §6).
 *
 * A classic script, not a module, and loaded *synchronously* in every page's
 * `<head>` — both deliberately. A `type="module"` script is deferred by
 * definition, so it cannot run before first paint, and this exists precisely to
 * run before first paint: without it a reader who chose dark gets a white flash
 * on every navigation.
 *
 * **Its own file rather than an inline `<script>`**, which is what the Chalk doc
 * §6 shows. Inline is fine until the day this app grows a
 * `Content-Security-Policy`, at which point it would force `'unsafe-inline'` for
 * scripts — which is most of what a script CSP is for. tscheggsch reached the
 * same conclusion from the other direction (it has a CSP, and this was a code
 * review finding). Six bytes of extra request against never having to unpick
 * that later.
 *
 * The `try` is not decoration: `localStorage` *throws* on access in some private
 * browsing modes rather than returning null, and an uncaught throw here would
 * abort the script before the page's own modules load. Falling back to light is
 * the right answer — light is `:root`, so doing nothing is already correct.
 *
 * Read by `wireThemeToggle()` in `util.js`, which is the only writer.
 */
try {
  if (localStorage.getItem('chalk-theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
} catch (e) {
  /* private mode: fall through to the light theme, which needs no attribute */
}
