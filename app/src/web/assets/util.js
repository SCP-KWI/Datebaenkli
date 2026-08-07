/**
 * The helpers every page script needs, in one place.
 *
 * Extracted when `csv-import.js` became the second module on the student page:
 * the first two are the sort of thing that is quietly wrong when it is written
 * twice — an `esc` that forgets `"` is an attribute-injection bug, and a `json`
 * that forgets its content type is a silent 415 that looks like a dead button.
 * `wireThemeToggle` joined them in phase 7 for the same reason: six pages, one
 * button, and a copy that forgets to write `localStorage` is a toggle that works
 * until you navigate.
 *
 * `ticked` and `mb` joined them in 7.2, and both are here for that same test —
 * not "this is used twice", but "the second copy can be wrong without anyone
 * seeing it". Each says which way at its own definition.
 */

/**
 * Display names and every catalog name are free text; none of it is trusted markup.
 *
 * The apostrophe is escaped even though every attribute in this app is written
 * with double quotes — which was the actual, unwritten reason the set of five
 * was safe as a set of four. That invariant held across six pages by nothing
 * but habit, and the failure it guards against is silent: `title='${esc(x)}'`
 * looks exactly like the correct line and is an injection. One character here
 * costs nothing and removes the requirement to remember.
 */
export const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * Escape first, *then* turn `` `x` `` into `<code>x</code>`.
 *
 * That order is the whole safety argument: a hint interpolates identifiers the
 * student chose, so `CREATE TABLE "<img onerror=…>"` reaches this function.
 * After `esc()` there is no `<` left to open a tag, and backticks survive
 * escaping untouched. Doing it the other way round would be an injection.
 * `hints.js` strips backticks out of identifiers so the pairs cannot be
 * unbalanced by a table name containing one.
 *
 * Shared once `csv-import.js` grew a hint pane of its own: the two panes render
 * the same `hints.js` output, and the version of this that is *only* safe when
 * you remember the ordering is precisely the one not to write twice.
 */
export const ticked = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');

/**
 * Bytes as the one string this app states disk usage in.
 *
 * Shared rather than copied because the teacher's lesson view and the student's
 * schema browser now show the **same number about the same schema**, and that
 * agreement is the whole argument for showing it to the student at all (HANDOFF
 * §8.6). Two `toFixed` calls in two files is exactly how that quietly stops
 * being true.
 *
 * A bare `.` rather than `formats().number`: `de-CH` and `en-CH` both use a
 * point for the decimal separator, so the locale-aware version formats
 * identically — and this is called from render paths that run before `/api/me`
 * has answered, where `formats()` would pin the cached locale.
 */
export const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The method is a parameter because PATCH and DELETE need the header for the
 * same reason POST does — `server.ts` applies the check to every non-GET `/api`
 * request, not just POSTs, so a roster's "archivieren" is a 415 without it.
 */
export const json = (body, method = 'POST') => ({
  method,
  // Not optional: the content type *is* the CSRF control, so a POST without it
  // is a 415 and the click silently does nothing.
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/**
 * The light/dark toggle. `theme.js` applies the stored choice before first
 * paint; this is the only thing that writes it.
 *
 * **The theme is device-local and `localStorage` is its source of truth** — the
 * opposite of the language, which lives in `app_user.locale` and treats its
 * `chalk-lang` key as a cache (`i18n.js`). The two keys sit side by side and
 * look like siblings, so the difference is worth stating: a teacher who wants
 * dark on the classroom projector and light on their laptop is expressing a
 * preference *about that screen*, and syncing it to the account would be a bug.
 * A student switching to English is expressing something about themselves, and
 * not syncing that would be the bug.
 *
 * The icon is the *target* state, not the current one — `dark_mode` while light,
 * per Chalk §6. The label has to say the same thing.
 *
 * **This function is the only owner of that `aria-label`, and the button must
 * not carry a `data-i18n-attr` for it.** Both together is a bug that testing in
 * light mode cannot find: `apply()` writes whatever constant key the markup
 * names, it runs *after* this wiring on every page, and so a reader in dark mode
 * got the icon for "switch to light" beside the label "switch to dark". The two
 * only agree in the mode the author happened to be in.
 *
 * **`labelFor` is a callback, not two strings**, and that is not ceremony: pages
 * wire this once against the cached locale and then load the authoritative one
 * from `/api/me` a moment later. Captured strings would be from the first of
 * those and would survive the second, so a student who switched to English would
 * flip the toggle and get a German label. Calling `t` late reads the live
 * binding that `load()` swaps.
 *
 * **Returns its paint function**, which the page must call again once that
 * authoritative locale has landed — wiring early is what makes the button live
 * during the `/api/me` round trip, and re-painting is what stops the label being
 * stuck in the cached language when the two disagree.
 */
export function wireThemeToggle(button, labelFor) {
  if (!button) return () => {};
  const root = document.documentElement;

  const paint = () => {
    const dark = root.getAttribute('data-theme') === 'dark';
    button.textContent = dark ? 'light_mode' : 'dark_mode';
    const label = labelFor?.(dark);
    if (label) button.setAttribute('aria-label', label);
  };

  button.addEventListener('click', () => {
    const dark = root.getAttribute('data-theme') === 'dark';
    if (dark) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', 'dark');
    // Wrapped for the reason `theme.js` explains: access can throw outright in
    // private browsing. A toggle that works for this page but is forgotten on
    // the next one beats one that throws and takes the page's script with it.
    try {
      localStorage.setItem('chalk-theme', dark ? 'light' : 'dark');
    } catch (e) {
      /* private mode: the choice lasts as long as this document */
    }
    paint();
  });

  paint();
  return paint;
}

/**
 * Fill in the footer's build stamp. Every page has one; only this fills it.
 *
 * **Never rejects, and renders nothing rather than something wrong.** It runs on
 * `login.html` too, where it is the only fetch on the page — so a failure here
 * must not be able to take the login form with it. `catch` leaving the version
 * blank is the right outcome: the contact address beside it is static markup and
 * is the half that actually matters when something is broken.
 *
 * The date is formatted through the page's locale (`de-CH`/`en-CH`, see
 * `i18n.js`), which is why this takes a formatter rather than reaching for
 * `toLocaleString()` itself — the bare call would use the *browser's* locale and
 * put an English date under a German page.
 */
export async function mountVersion(element, formatDate) {
  if (!element) return;
  const info = await fetch('/api/version')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!info) return;

  // `builtAt: null` is a dev run, not a failure — say so rather than printing
  // an empty separator that looks like something failed to load.
  const stamp = info.builtAt ? formatDate(new Date(info.builtAt)) : 'dev';
  element.textContent = `v${info.version} · ${stamp}`;
}
